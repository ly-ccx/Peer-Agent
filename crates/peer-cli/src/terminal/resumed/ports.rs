//! Bounded presentation and a one-shot reply for each live Host permission.
use peer_runtime::{
    CancellationToken,
    capability::CapabilityError,
    conversation_host::{ConversationEvent, ConversationOutput},
    session_host::{LocalPermissionDecision, PermissionInput},
};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};

const MAX_PREVIEW: usize = 8192;
const MAX_APPROVAL: usize = 8192;
const STREAM_PREFIX: &str = "Peer  ";
const STREAM_TRUNCATED: &str = "Peer  ［较早的流式正文已折叠］ ";

const THINKING_TRUNCATED: &str = "… ";

#[derive(Default)]
pub(in crate::terminal) struct Display {
    pub accepted: bool,
    pub revision: usize,
    pub delta_revision: usize,
    pub live: String,
    pub live_thinking: String,
    pub notice: Option<&'static str>,
    pub conversation_id: Option<String>,
    truncated: bool,
    thinking_truncated: bool,
}

fn push_live_chunk(
    buf: &mut String,
    truncated: &mut bool,
    text: &str,
    initial_prefix: &str,
    truncated_prefix: &str,
) {
    let max = MAX_PREVIEW.saturating_sub(truncated_prefix.len());
    let start = next_boundary(text, text.len().saturating_sub(max));
    let clean = peer_tui::terminal_text(&text[start..]);
    if buf.is_empty() && !initial_prefix.is_empty() {
        buf.push_str(initial_prefix);
    }
    if start != 0 || buf.len() + clean.len() > MAX_PREVIEW {
        let prefix = if *truncated {
            truncated_prefix
        } else {
            initial_prefix
        };
        let remove = (buf.len() + clean.len() + truncated_prefix.len())
            .saturating_sub(MAX_PREVIEW + prefix.len());
        let end = next_boundary(buf, (prefix.len() + remove).min(buf.len()));
        buf.replace_range(..end, truncated_prefix);
        *truncated = true;
    }
    buf.push_str(&clean);
}

pub(in crate::terminal) struct OutputPort(pub watch::Sender<Display>);
impl ConversationOutput for OutputPort {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilityError>> + 'a>> {
        Box::pin(async move {
            self.0.send_modify(|display| match event {
                ConversationEvent::ThinkingDelta(text) => {
                    push_live_chunk(
                        &mut display.live_thinking,
                        &mut display.thinking_truncated,
                        text,
                        "",
                        THINKING_TRUNCATED,
                    );
                    display.delta_revision += 1;
                }
                ConversationEvent::AssistantDelta(text) => {
                    push_live_chunk(
                        &mut display.live,
                        &mut display.truncated,
                        text,
                        STREAM_PREFIX,
                        STREAM_TRUNCATED,
                    );
                    display.delta_revision += 1;
                }
                ConversationEvent::Started { conversation_id } => {
                    display.accepted = true;
                    display.conversation_id = Some(conversation_id.to_owned());
                    display.revision += 1;
                }
                ConversationEvent::AssistantText(_) | ConversationEvent::ToolPrepared { .. } => {
                    display.live.clear();
                    display.live_thinking.clear();
                    display.truncated = false;
                    display.thinking_truncated = false;
                    display.revision += 1;
                }
                ConversationEvent::ToolSettled { .. } => {
                    display.revision += 1;
                }
            });
            Ok(())
        })
    }
}

pub(in crate::terminal) struct Approval {
    pub text: String,
    pub card: peer_tui::ApprovalCard,
    pub selected: usize,
    pub reply: oneshot::Sender<LocalPermissionDecision>,
    pub scroll: usize,
    pub shown_at: Option<(u16, u16)>,
}
impl Approval {
    pub fn expired(&self) -> bool {
        self.reply.is_closed()
    }
}

pub(in crate::terminal) fn build_approval_card(
    tool: &str,
    prompt: &Value,
) -> peer_tui::ApprovalCard {
    let cap = prompt["capabilityId"]
        .as_str()
        .or_else(|| prompt["approval"]["capabilityId"].as_str())
        .or_else(|| prompt["scopes"][0]["capabilityId"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let action = match cap {
        Some(c) if c != tool => format!("{tool} ({c})"),
        _ => tool.to_owned(),
    };
    let raw_location = prompt["scopes"][0]["path"]
        .as_str()
        .or_else(|| prompt["workspacePath"].as_str())
        .or_else(|| prompt["scopes"][0]["workspacePath"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Current workspace");
    let location = if raw_location.starts_with("/Users/") || raw_location.starts_with("/home/") {
        peer_tui::compact_workspace_path(raw_location)
    } else {
        raw_location.to_owned()
    };
    let reason = prompt["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("This action needs your approval before local execution.");
    let risk = prompt["riskLevel"]
        .as_str()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "runtime governed".to_owned());
    let raw_args = if prompt["arguments"].is_null() {
        "No arguments".to_owned()
    } else if let Some(s) = prompt["arguments"].as_str() {
        s.to_owned()
    } else {
        serde_json::to_string(&prompt["arguments"]).unwrap_or_else(|_| "No arguments".to_owned())
    };
    let single_line = raw_args.split_whitespace().collect::<Vec<_>>().join(" ");
    let compact_args = if single_line.is_empty() {
        "No arguments".to_owned()
    } else {
        bounded_text(&single_line, 240)
    };
    peer_tui::ApprovalCard {
        action: peer_tui::terminal_text(&action),
        location: peer_tui::terminal_text(&location),
        reason: peer_tui::terminal_text(reason),
        risk: peer_tui::terminal_text(&risk),
        arguments: peer_tui::terminal_text(&compact_args),
    }
}

pub(in crate::terminal) struct PermissionPort {
    pub requests: mpsc::Sender<Approval>,
    pub display: watch::Sender<Display>,
}
impl PermissionInput for PermissionPort {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async move {
            use LocalPermissionDecision::{Cancel, Deny, Timeout};
            if cancel.is_cancelled() {
                return Cancel;
            }
            let (Some(tool), Some(call)) = (prompt["tool"].as_str(), prompt["toolCallId"].as_str())
            else {
                return Deny;
            };
            let details = json!({"arguments":prompt["arguments"],"scopes":prompt["scopes"]});
            let Ok(details) = serde_json::to_string_pretty(&details) else {
                return Deny;
            };
            let text = format!("本地授权请求 · {tool}\n调用 {call}\n{details}");
            if text.len() > MAX_APPROVAL || peer_tui::terminal_text(&text) != text {
                self.display.send_modify(|display| {
                    display.notice = Some("授权详情无法完整安全显示，本次调用已拒绝。");
                });
                return Deny;
            }
            let card = build_approval_card(tool, &prompt);
            let (reply, receive) = oneshot::channel();
            if self
                .requests
                .try_send(Approval {
                    text,
                    card,
                    selected: 0,
                    reply,
                    scroll: 0,
                    shown_at: None,
                })
                .is_err()
            {
                return Deny;
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Cancel,
                answer = receive => answer.unwrap_or(Deny),
                _ = tokio::time::sleep(Duration::from_secs(60)) => Timeout,
            }
        })
    }
}

pub(in crate::terminal) fn bounded_text(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut preview = peer_tui::terminal_text(&text[..end]);
    if end < text.len() {
        preview.push_str(" ［预览，完整正文见导出］");
    }
    preview
}

fn next_boundary(text: &str, mut start: usize) -> usize {
    while !text.is_char_boundary(start) {
        start += 1;
    }
    start
}
