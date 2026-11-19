//! Bot directory, attention projection, reply-question lifecycle, and bounded interaction pages.
//!
//! Matches `packages/protocol/src/project.ts`, `packages/runtime-node/src/project-agent/bot-directory.mjs`,
//! and `packages/runtime-node/src/project-agent/attention.mjs` (ADR 84, ADR 100).

use crate::{
    BotProfile, BotProfileStore, ProjectError, ProjectRegistry, atomic_write,
    is_valid_workspace_id, now_iso, parse_iso_ms,
};
use peer_store::{ApprovalStore, ConversationStore};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

const PREVIEW_MAX: usize = 80;
const VISIBLE_KINDS: [&str; 4] = ["user_input", "agent_reply", "system_card", "agent_activity"];
const RUNNING_STATUSES: [&str; 3] = ["starting", "running", "verifying"];
const TERMINAL_SESSION_STATUSES: [&str; 4] = ["accepted", "cancelled", "failed", "superseded"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotListSession {
    pub session_id: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_confirmation_required: Option<bool>,
    #[serde(default)]
    pub completion_review_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotListMessage {
    pub role: String,
    pub text: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count_unread: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRowState {
    pub needs_you: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attention_expires_at: Option<String>,
    pub unread: usize,
    pub running: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotListItem {
    pub workspace_id: String,
    pub profile: BotProfile,
    pub preview: String,
    pub last_active_at: String,
    pub state: BotRowState,
}

#[derive(Debug, Clone, Default)]
pub struct BotListFilter {
    pub query: Option<String>,
    pub needs_you_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    Question,
    Confirmation,
    Approval,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    pub workspace_id: String,
    pub bot_name: String,
    pub kind: AttentionKind,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionState {
    Open,
    Answered,
    Expired,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyQuestionStatus {
    pub message_id: String,
    pub state: QuestionState,
    pub answered_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FamiliarizeOffer {
    pub kind: String,
    pub text: String,
    pub action: String,
}

pub fn default_familiarize_offer() -> FamiliarizeOffer {
    FamiliarizeOffer {
        kind: "familiarize".to_owned(),
        text: "要我先熟悉一下这个项目吗？".to_owned(),
        action: "先熟悉一下".to_owned(),
    }
}

#[derive(Debug, Clone)]
pub struct InteractionPage {
    pub messages: Vec<Value>,
    pub next_cursor: Option<String>,
    pub familiarize_offer: Option<FamiliarizeOffer>,
}

fn clip(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(limit).collect()
}

fn message_kind(message: &Value) -> &str {
    message["kind"]
        .as_str()
        .or_else(|| message["type"].as_str())
        .or_else(|| message["messageKind"].as_str())
        .unwrap_or("")
}

fn message_text(message: &Value) -> String {
    let text = message["content"]
        .as_str()
        .or_else(|| message["text"].as_str())
        .unwrap_or("");
    if !text.trim().is_empty() {
        return text.to_owned();
    }
    message["attachments"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item["name"].as_str())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn message_at(message: &Value) -> &str {
    message["createdAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| message["at"].as_str().filter(|s| !s.is_empty()))
        .unwrap_or("")
}

pub fn is_visible_bot_message(message: &Value) -> bool {
    let kind = message_kind(message);
    if kind == "agent_activity"
        && matches!(
            message["agentActivity"]["state"].as_str(),
            Some("verifying" | "verified")
        )
    {
        return false;
    }
    if kind == "system_card"
        && let Some(cards) = message["cards"].as_array()
        && !cards.is_empty()
        && cards.iter().all(|c| c["kind"] == "verdict")
    {
        return false;
    }
    if VISIBLE_KINDS.contains(&kind) {
        return true;
    }
    kind.is_empty() && matches!(message["role"].as_str(), Some("user" | "assistant"))
}

pub fn project_bot_list_message(message: &Value) -> BotListMessage {
    let kind = message_kind(message);
    let role = if kind == "user_input" || message["role"] == "user" {
        "user"
    } else {
        "assistant"
    };
    let surfacing = if kind == "agent_activity" {
        Some("silent")
    } else {
        message["meta"]["surfacing"]
            .as_str()
            .or_else(|| message["surfacing"].as_str())
    };
    let count_unread =
        if surfacing == Some("silent") || message["meta"]["unread"].as_bool() == Some(false) {
            Some(false)
        } else {
            None
        };
    BotListMessage {
        role: role.to_owned(),
        text: clip(&message_text(message), PREVIEW_MAX),
        at: message_at(message).to_owned(),
        count_unread,
    }
}

/// Computes open/answered/expired/superseded state for reply questions (ADR 100).
pub fn project_reply_questions(
    messages: &[Value],
    now_ms: i64,
) -> HashMap<String, ReplyQuestionStatus> {
    let mut out: HashMap<String, ReplyQuestionStatus> = HashMap::new();
    let mut open_ids: Vec<String> = Vec::new();
    for msg in messages {
        let kind = message_kind(msg);
        if kind == "user_input" || (kind.is_empty() && msg["role"] == "user") {
            let user_id = msg["id"].as_str().map(str::to_owned);
            if let Some(target) = msg["answerTo"].as_str() {
                if let Some(status) = out.get_mut(target) {
                    status.state = QuestionState::Answered;
                    status.answered_by = user_id.clone();
                }
                open_ids.retain(|id| id != target);
            } else {
                // Ordinary subsequent user message supersedes any older open conversational question.
                for id in open_ids.drain(..) {
                    if let Some(status) = out.get_mut(&id)
                        && status.state == QuestionState::Open
                    {
                        status.state = QuestionState::Superseded;
                    }
                }
            }
            continue;
        }
        if kind == "agent_reply" && msg["question"].is_object() {
            let Some(id) = msg["id"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let expired = msg["question"]["expiresAt"]
                .as_str()
                .and_then(parse_iso_ms)
                .is_some_and(|exp| exp <= now_ms);
            let state = if expired {
                QuestionState::Expired
            } else {
                QuestionState::Open
            };
            out.insert(
                id.to_owned(),
                ReplyQuestionStatus {
                    message_id: id.to_owned(),
                    state,
                    answered_by: None,
                },
            );
            if state == QuestionState::Open {
                open_ids.push(id.to_owned());
            }
        }
    }
    out
}

pub fn project_bot_attention(
    profile: &BotProfile,
    messages: &[Value],
    sessions: &[BotListSession],
    approvals: &[Value],
    now_ms: i64,
) -> Vec<AttentionItem> {
    let mut items = Vec::new();
    let mut seen_ids = HashSet::new();
    let sessions_by_id: HashMap<&str, &BotListSession> = sessions
        .iter()
        .map(|s| (s.session_id.as_str(), s))
        .collect();
    let mut approval_sessions = HashSet::new();

    for approval in approvals {
        let state = approval["state"].as_str().unwrap_or("");
        if !matches!(state, "open" | "stale") {
            continue;
        }
        if approval["kind"] == "image_read_grant" {
            continue;
        }
        let session_id = approval["sessionId"].as_str();
        if let Some(sid) = session_id
            && let Some(sess) = sessions_by_id.get(sid)
            && TERMINAL_SESSION_STATUSES.contains(&sess.status.as_str())
        {
            continue;
        }
        if approval["deadlineAt"]
            .as_str()
            .and_then(parse_iso_ms)
            .is_some_and(|dl| dl <= now_ms)
        {
            continue;
        }
        let Some(approval_id) = approval["approvalId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if let Some(sid) = session_id {
            approval_sessions.insert(sid.to_owned());
        }
        let item_id = format!("approval:{approval_id}");
        if seen_ids.insert(item_id.clone()) {
            let title = approval["summary"]
                .as_str()
                .or_else(|| approval["capabilityId"].as_str())
                .unwrap_or("approval")
                .chars()
                .take(2000)
                .collect();
            items.push(AttentionItem {
                id: item_id,
                workspace_id: profile.workspace_id.clone(),
                bot_name: profile.display_name.clone(),
                kind: AttentionKind::Approval,
                title,
                created_at: approval["createdAt"].as_str().map(str::to_owned),
                expires_at: approval["deadlineAt"].as_str().map(str::to_owned),
                message_id: None,
                session_id: session_id.map(str::to_owned),
                approval_id: Some(approval_id.to_owned()),
            });
        }
    }

    let question_states = project_reply_questions(messages, now_ms);
    for msg in messages {
        let Some(mid) = msg["id"].as_str() else {
            continue;
        };
        if question_states
            .get(mid)
            .is_some_and(|st| st.state == QuestionState::Open)
        {
            let item_id = format!("question:{mid}");
            if seen_ids.insert(item_id.clone()) {
                let title = msg["question"]["prompt"]
                    .as_str()
                    .or_else(|| msg["content"].as_str())
                    .unwrap_or("")
                    .chars()
                    .take(2000)
                    .collect();
                items.push(AttentionItem {
                    id: item_id,
                    workspace_id: profile.workspace_id.clone(),
                    bot_name: profile.display_name.clone(),
                    kind: AttentionKind::Question,
                    title,
                    created_at: msg["createdAt"].as_str().map(str::to_owned),
                    expires_at: msg["question"]["expiresAt"].as_str().map(str::to_owned),
                    message_id: Some(mid.to_owned()),
                    session_id: None,
                    approval_id: None,
                });
            }
        }
    }

    for session in sessions {
        if approval_sessions.contains(&session.session_id) {
            continue;
        }
        let needs_confirm = session.status == "result_ready"
            && session
                .result_confirmation_required
                .unwrap_or_else(|| profile.acceptance_policy_str() == "confirm");
        if needs_confirm {
            let item_id = format!("confirm:{}", session.session_id);
            if seen_ids.insert(item_id.clone()) {
                items.push(AttentionItem {
                    id: item_id,
                    workspace_id: profile.workspace_id.clone(),
                    bot_name: profile.display_name.clone(),
                    kind: AttentionKind::Confirmation,
                    title: session.title.clone(),
                    created_at: session.updated_at.clone(),
                    expires_at: None,
                    message_id: None,
                    session_id: Some(session.session_id.clone()),
                    approval_id: None,
                });
            }
        }
        if session.completion_review_required {
            let item_id = format!("completion:{}", session.session_id);
            if seen_ids.insert(item_id.clone()) {
                items.push(AttentionItem {
                    id: item_id,
                    workspace_id: profile.workspace_id.clone(),
                    bot_name: profile.display_name.clone(),
                    kind: AttentionKind::Confirmation,
                    title: session.title.clone(),
                    created_at: session.updated_at.clone(),
                    expires_at: None,
                    message_id: None,
                    session_id: Some(session.session_id.clone()),
                    approval_id: None,
                });
            }
        }
    }

    items
}

pub fn project_bot_list_item(
    profile: BotProfile,
    last_message: Option<&BotListMessage>,
    sessions: &[BotListSession],
    attention: &[AttentionItem],
    read_cursor: Option<&str>,
) -> BotListItem {
    let running = sessions
        .iter()
        .filter(|s| RUNNING_STATUSES.contains(&s.status.as_str()))
        .count();
    let unread = match last_message {
        Some(msg)
            if msg.role == "assistant"
                && msg.count_unread != Some(false)
                && read_cursor.is_none_or(|c| msg.at.as_str() > c) =>
        {
            1
        }
        _ => 0,
    };
    let mut latest = String::new();
    for candidate in std::iter::once(last_message.map(|m| m.at.as_str()))
        .chain(std::iter::once(profile.updated_at.as_deref()))
        .chain(sessions.iter().map(|s| s.updated_at.as_deref()))
        .flatten()
    {
        if !candidate.is_empty() && (latest.is_empty() || candidate > latest.as_str()) {
            latest = candidate.to_owned();
        }
    }
    let attention_expires_at = attention
        .iter()
        .filter_map(|a| a.expires_at.as_deref())
        .min()
        .map(str::to_owned);
    BotListItem {
        workspace_id: profile.workspace_id.clone(),
        profile,
        preview: last_message.map(|m| m.text.clone()).unwrap_or_default(),
        last_active_at: latest,
        state: BotRowState {
            needs_you: attention.len(),
            attention_expires_at,
            unread,
            running,
            agent_status: None,
        },
    }
}

pub fn sort_bot_list(mut items: Vec<BotListItem>) -> Vec<BotListItem> {
    items.sort_by(|a, b| {
        let ta = parse_iso_ms(&a.last_active_at).unwrap_or(0);
        let tb = parse_iso_ms(&b.last_active_at).unwrap_or(0);
        tb.cmp(&ta)
    });
    items
}

pub fn filter_bot_list(items: Vec<BotListItem>, filter: &BotListFilter) -> Vec<BotListItem> {
    let query = filter
        .query
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    items
        .into_iter()
        .filter(|item| {
            if filter.needs_you_only && item.state.needs_you == 0 {
                return false;
            }
            if query.is_empty() {
                return true;
            }
            let hay = format!("{}\n{}", item.profile.display_name, item.preview).to_lowercase();
            hay.contains(&query)
        })
        .collect()
}

pub struct BotDirectory {
    data_home: PathBuf,
    profiles: BotProfileStore,
    registry: ProjectRegistry,
    conversations: ConversationStore,
    approvals: ApprovalStore,
}

impl BotDirectory {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            profiles: BotProfileStore::new(&home),
            registry: ProjectRegistry::new(&home),
            conversations: ConversationStore::new(&home),
            approvals: ApprovalStore::new(&home),
            data_home: home,
        }
    }

    fn read_cursor_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("read-cursor.json"))
    }

    pub fn read_cursor(&self, workspace_id: &str) -> Option<String> {
        let file = self.read_cursor_file(workspace_id).ok()?;
        let raw = fs::read_to_string(file).ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        parsed["at"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }

    pub fn mark_read(&self, workspace_id: &str, at: Option<&str>) -> Result<String, ProjectError> {
        let file = self.read_cursor_file(workspace_id)?;
        let stamp = at
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(now_iso);
        let body = serde_json::to_string(&json!({ "at": stamp }))
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        atomic_write(&file, body.as_bytes())?;
        Ok(stamp)
    }

    /// Bounded paginated read of visible bot conversation messages (newest-tail pagination).
    pub fn read_interactions(
        &self,
        workspace_id: &str,
        limit: usize,
        before_message_id: Option<&str>,
    ) -> Result<InteractionPage, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let familiarize_offer = (before_message_id.is_none() && profile.familiarize.is_none())
            .then(default_familiarize_offer);
        let Some(conv_id) = profile.agent_conversation_id.as_deref() else {
            return Ok(InteractionPage {
                messages: Vec::new(),
                next_cursor: None,
                familiarize_offer,
            });
        };
        let snapshot = match self
            .conversations
            .read_committed(conv_id, None, 8 * 1024 * 1024)
        {
            Ok(s) => s,
            Err(peer_store::StoreError::NotFound) => {
                return Ok(InteractionPage {
                    messages: Vec::new(),
                    next_cursor: None,
                    familiarize_offer,
                });
            }
            Err(e) => return Err(e.into()),
        };
        let visible: Vec<Value> = snapshot
            .history
            .messages
            .into_iter()
            .filter(is_visible_bot_message)
            .collect();
        let end = match before_message_id {
            Some(cursor_id) => visible
                .iter()
                .position(|m| m["id"].as_str() == Some(cursor_id))
                .unwrap_or(visible.len()),
            None => visible.len(),
        };
        let cap = limit.clamp(1, 200);
        let start = end.saturating_sub(cap);
        let page = visible[start..end].to_vec();
        let next_cursor = if start > 0 {
            page.first()
                .and_then(|m| m["id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok(InteractionPage {
            messages: page,
            next_cursor,
            familiarize_offer,
        })
    }

    pub fn list(
        &self,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
    ) -> Vec<BotListItem> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut items = Vec::new();
        for workspace_id in self.profiles.list_workspace_ids() {
            let Some(profile) = self.profiles.read(&workspace_id) else {
                continue;
            };
            if !profile.is_active() {
                continue;
            }
            let messages = self
                .read_interactions(&workspace_id, 200, None)
                .map(|p| p.messages)
                .unwrap_or_default();
            let last_msg = messages
                .iter()
                .rev()
                .find(|m| message_kind(m) != "agent_activity")
                .map(project_bot_list_message);
            let sessions = sessions_by_workspace
                .get(&workspace_id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let approvals = self
                .approvals
                .list(Some(&workspace_id), None)
                .unwrap_or_default();
            let attention =
                project_bot_attention(&profile, &messages, sessions, &approvals, now_ms);
            let cursor = self.read_cursor(&workspace_id);
            items.push(project_bot_list_item(
                profile,
                last_msg.as_ref(),
                sessions,
                &attention,
                cursor.as_deref(),
            ));
        }
        sort_bot_list(items)
    }

    pub fn find_active_bot_for_path(&self, workspace_path: &str) -> Option<BotProfile> {
        let entry = self.registry.find_by_path(workspace_path).ok()??;
        let profile = self.profiles.read(&entry.workspace_id)?;
        profile.is_active().then_some(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateBotProfile;
    use peer_store::NewProjectConversation;
    use tempfile::tempdir;

    #[test]
    fn bot_directory_lists_active_bots_with_unread_and_attention() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        let convs = ConversationStore::new(dir.path());
        let at = "2026-11-19T01:00:00.000Z";
        let conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Alpha",
                    workspace_id: "ws-alpha",
                    workspace_path: Some("/tmp/alpha"),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: at,
                },
                None,
                None,
            )
            .unwrap();
        let conv_id = conv["id"].as_str().unwrap();
        profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-alpha",
                display_name: "Alpha",
                managed: false,
                agent_conversation_id: conv_id,
                avatar_salt: "",
            })
            .unwrap();
        convs
            .append_message_idempotent(
                conv_id,
                &json!({
                    "id": "reply-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Choose option A or B?",
                    "createdAt": "2026-11-19T01:05:00.000Z",
                    "question": {"options": ["A", "B"]}
                }),
                "2026-11-19T01:05:00.000Z",
                None,
            )
            .unwrap();

        let directory = BotDirectory::new(dir.path());
        let listed = directory.list(&HashMap::new());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].state.unread, 1);
        assert_eq!(listed[0].state.needs_you, 1);

        directory
            .mark_read("ws-alpha", Some("2026-11-19T01:06:00.000Z"))
            .unwrap();
        let listed2 = directory.list(&HashMap::new());
        assert_eq!(listed2[0].state.unread, 0);
        assert_eq!(listed2[0].state.needs_you, 1);
    }

    #[test]
    fn read_interactions_emits_familiarize_offer_until_started_even_without_conv_file() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-fresh",
                display_name: "FreshBot",
                managed: false,
                agent_conversation_id: "conv-missing-on-disk",
                avatar_salt: "",
            })
            .unwrap();

        let directory = BotDirectory::new(dir.path());
        let first_page = directory.read_interactions("ws-fresh", 50, None).unwrap();
        assert_eq!(
            first_page.familiarize_offer,
            Some(default_familiarize_offer())
        );

        let paged = directory
            .read_interactions("ws-fresh", 50, Some("cursor-1"))
            .unwrap();
        assert_eq!(paged.familiarize_offer, None);

        let mut prof = profiles.read("ws-fresh").unwrap();
        prof.familiarize = Some(json!({ "kind": "research", "dispatched": true }));
        profiles.save(prof).unwrap();

        let after_started = directory.read_interactions("ws-fresh", 50, None).unwrap();
        assert_eq!(after_started.familiarize_offer, None);
    }
}
