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

#[derive(Default)]
pub(in crate::terminal) struct Display {
    pub accepted: bool,
    pub revision: usize,
    pub live: String,
    pub notice: Option<&'static str>,
    pub conversation_id: Option<String>,
    truncated: bool,
}

pub(in crate::terminal) struct OutputPort(pub watch::Sender<Display>);
impl ConversationOutput for OutputPort {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilityError>> + 'a>> {
        Box::pin(async move {
            self.0.send_modify(|display| match event {
                ConversationEvent::AssistantDelta(text) => {
                    let max = MAX_PREVIEW - STREAM_TRUNCATED.len();
                    let start = next_boundary(text, text.len().saturating_sub(max));
                    let text = peer_tui::terminal_text(&text[start..]);
                    if display.live.is_empty() {
                        display.live.push_str(STREAM_PREFIX);
                    }
                    if start != 0 || display.live.len() + text.len() > MAX_PREVIEW {
                        let prefix = if display.truncated {
                            STREAM_TRUNCATED
                        } else {
                            STREAM_PREFIX
                        };
                        let remove = (display.live.len() + text.len() + STREAM_TRUNCATED.len())
                            .saturating_sub(MAX_PREVIEW + prefix.len());
                        let end = next_boundary(&display.live, prefix.len() + remove);
                        display.live.replace_range(..end, STREAM_TRUNCATED);
                        display.truncated = true;
                    }
                    display.live.push_str(&text);
                }
                ConversationEvent::Started { conversation_id } => {
                    display.accepted = true;
                    display.conversation_id = Some(conversation_id.to_owned());
                    display.revision += 1;
                }
                ConversationEvent::AssistantText(_) => {
                    display.live.clear();
                    display.truncated = false;
                    display.revision += 1;
                }
                ConversationEvent::ToolPrepared { .. } | ConversationEvent::ToolSettled { .. } => {
                    display.revision += 1;
                }
            });
            Ok(())
        })
    }
}

pub(in crate::terminal) struct Approval {
    pub text: String,
    pub reply: oneshot::Sender<LocalPermissionDecision>,
    pub scroll: usize,
    pub shown_at: Option<(u16, u16)>,
}
impl Approval {
    pub fn expired(&self) -> bool {
        self.reply.is_closed()
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
            let (reply, receive) = oneshot::channel();
            if self
                .requests
                .try_send(Approval {
                    text,
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
