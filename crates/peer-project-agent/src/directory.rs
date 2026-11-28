//! Bot directory, attention projection, reply-question lifecycle, and bounded interaction pages.
//!
//! Matches `packages/protocol/src/project.ts`, `packages/runtime-node/src/project-agent/bot-directory.mjs`,
//! and `packages/runtime-node/src/project-agent/attention.mjs` (ADR 84, ADR 100).

use crate::{
    BotProfile, BotProfileStore, FollowUpProjection, InputQueue, ProjectError, ProjectRegistry,
    QueuedInputMeta, atomic_write, cards, is_valid_workspace_id, now_iso, parse_iso_ms,
};
use peer_runtime::tool_markup::strip_literal_tool_call_blocks;
use peer_store::{ApprovalStore, ConversationStore, StoreError};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up: Option<FollowUpProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_sessions: Vec<BotListSession>,
    #[serde(default)]
    pub active_session_total: usize,
    #[serde(default)]
    pub history_session_total: usize,
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
    pub card: Option<Value>,
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
    pub source_version: String,
    pub familiarize_offer: Option<FamiliarizeOffer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ReadConversationOptions {
    pub limit: Option<usize>,
    pub before: Option<String>,
    pub kinds: Option<Vec<String>>,
    pub latest: bool,
    pub presentation_only: bool,
    pub process_for: Option<String>,
    pub view: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkReadResult {
    pub at: String,
    pub message_id: Option<String>,
    pub changed: bool,
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
    let raw = message["content"]
        .as_str()
        .or_else(|| message["text"].as_str())
        .unwrap_or("");
    let text = if !raw.trim().is_empty()
        && (message["role"].as_str() == Some("assistant")
            || matches!(message_kind(message), "agent_reply" | "agent_activity"))
    {
        strip_literal_tool_call_blocks(raw)
    } else {
        raw.to_owned()
    };
    if !text.trim().is_empty() {
        return text;
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
    if message.get("_compaction").is_some_and(Value::is_object)
        || message.get("compaction").is_some_and(Value::is_object)
    {
        return false;
    }
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
        if msg.get("_compaction").is_some_and(Value::is_object)
            || msg.get("compaction").is_some_and(Value::is_object)
        {
            continue;
        }
        let kind = message_kind(msg);
        if kind == "user_input" || (kind.is_empty() && msg["role"] == "user") {
            let user_id = msg["id"].as_str().map(str::to_owned);
            if let Some(raw_target) = msg["answerTo"].as_str() {
                let target = raw_target
                    .strip_prefix("card:question:reply:")
                    .unwrap_or(raw_target);
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
        if kind == "agent_reply" || (kind.is_empty() && msg["role"] == "assistant") {
            for id in open_ids.drain(..) {
                if let Some(status) = out.get_mut(&id)
                    && status.state == QuestionState::Open
                {
                    status.state = QuestionState::Superseded;
                }
            }
            if msg["question"].is_object() {
                let Some(id) = msg["id"].as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let explicitly_answered = msg["question"]["answered"].as_bool() == Some(true);
                let expired = msg["question"]["expiresAt"]
                    .as_str()
                    .and_then(parse_iso_ms)
                    .is_some_and(|exp| exp <= now_ms);
                let state = if explicitly_answered {
                    QuestionState::Answered
                } else if expired {
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
    }
    out
}

/// Extends [`project_reply_questions`] with durably queued (not yet consumed)
/// `InputQueue` items so attention badges, cards, and submit validation share one
/// authoritative view of question closure even while a workspace tick holds the lock.
pub fn project_reply_questions_with_queued(
    messages: &[Value],
    queued: &[QueuedInputMeta],
    now_ms: i64,
) -> HashMap<String, ReplyQuestionStatus> {
    let mut out = project_reply_questions(messages, now_ms);
    if queued.is_empty() || !out.values().any(|s| s.state == QuestionState::Open) {
        return out;
    }
    let mut present_input_ids: HashSet<&str> = HashSet::new();
    let mut open_created_at: HashMap<&str, Option<i64>> = HashMap::new();
    for msg in messages {
        if let Some(iid) = msg["inputId"].as_str().filter(|s| !s.is_empty()) {
            present_input_ids.insert(iid);
        }
        if let Some(id) = msg["id"].as_str().filter(|s| !s.is_empty()) {
            if let Some(stripped) = id.strip_prefix("input-")
                && !stripped.is_empty()
            {
                present_input_ids.insert(stripped);
            }
            if out
                .get(id)
                .is_some_and(|st| st.state == QuestionState::Open)
            {
                open_created_at.insert(id, msg["createdAt"].as_str().and_then(parse_iso_ms));
            }
        }
    }
    for item in queued {
        if present_input_ids.contains(item.input_id.as_str()) {
            continue;
        }
        if let Some(raw_target) = item
            .answer_to
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let target = raw_target
                .strip_prefix("card:question:reply:")
                .unwrap_or(raw_target);
            if let Some(status) = out.get_mut(target)
                && status.state == QuestionState::Open
            {
                status.state = QuestionState::Answered;
                status.answered_by = Some(format!("input-{}", item.input_id));
            }
        } else {
            let input_ms = parse_iso_ms(&item.created_at);
            for (qid, status) in &mut out {
                if status.state != QuestionState::Open {
                    continue;
                }
                let q_ms = open_created_at.get(qid.as_str()).copied().flatten();
                let supersedes = match (q_ms, input_ms) {
                    (Some(q), Some(i)) => q <= i,
                    _ => true,
                };
                if supersedes {
                    status.state = QuestionState::Superseded;
                }
            }
        }
    }
    out
}

/// True when `answer_to` is already answered in either canonical parent messages
/// or durably queued unconsumed inputs.
pub fn is_answer_recorded(messages: &[Value], queued: &[QueuedInputMeta], answer_to: &str) -> bool {
    messages
        .iter()
        .any(|m| m["answerTo"].as_str() == Some(answer_to))
        || queued
            .iter()
            .any(|q| q.answer_to.as_deref().map(str::trim) == Some(answer_to))
}

pub fn project_bot_attention(
    profile: &BotProfile,
    messages: &[Value],
    sessions: &[BotListSession],
    approvals: &[Value],
    now_ms: i64,
) -> Vec<AttentionItem> {
    project_bot_attention_with_cards(profile, messages, sessions, approvals, &[], &[], now_ms)
}

pub fn project_bot_attention_with_cards(
    profile: &BotProfile,
    messages: &[Value],
    sessions: &[BotListSession],
    approvals: &[Value],
    task_question_cards: &[Value],
    card_resolutions: &[cards::CardResolution],
    now_ms: i64,
) -> Vec<AttentionItem> {
    project_bot_attention_with_cards_and_queued(
        profile,
        messages,
        &[],
        sessions,
        approvals,
        task_question_cards,
        card_resolutions,
        now_ms,
    )
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn project_bot_attention_with_cards_and_queued(
    profile: &BotProfile,
    messages: &[Value],
    queued: &[QueuedInputMeta],
    sessions: &[BotListSession],
    approvals: &[Value],
    task_question_cards: &[Value],
    card_resolutions: &[cards::CardResolution],
    now_ms: i64,
) -> Vec<AttentionItem> {
    let sessions_by_id: HashMap<&str, &BotListSession> = sessions
        .iter()
        .map(|s| (s.session_id.as_str(), s))
        .collect();
    let question_states = project_reply_questions_with_queued(messages, queued, now_ms);
    let replies: Vec<&Value> = messages
        .iter()
        .filter(|msg| {
            msg["id"]
                .as_str()
                .and_then(|id| question_states.get(id))
                .is_some_and(|st| st.state == QuestionState::Open)
        })
        .collect();

    let mut pending_approvals: Vec<&Value> = Vec::new();
    let mut pending_sessions = HashSet::new();
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
        if approval["approvalId"].as_str().is_none_or(|s| s.is_empty()) {
            continue;
        }
        if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
            pending_sessions.insert(sid.to_owned());
        }
        pending_approvals.push(approval);
    }

    let mut pending_confirmations: Vec<cards::ConfirmCardInput> = Vec::new();
    for session in sessions {
        if pending_sessions.contains(&session.session_id) {
            continue;
        }
        let needs_confirm = session.status == "result_ready"
            && session
                .result_confirmation_required
                .unwrap_or_else(|| profile.acceptance_policy_str() == "confirm");
        if needs_confirm {
            pending_confirmations.push(cards::ConfirmCardInput {
                session_id: session.session_id.clone(),
                summary: session.title.clone(),
                accepted: false,
                needs_confirm: None,
            });
        }
    }

    let mut all_cards = cards::project_cards(
        &profile.workspace_id,
        &replies,
        &pending_approvals,
        &pending_confirmations,
        &[],
        card_resolutions,
    )
    .unwrap_or_default();

    for card in task_question_cards {
        if card["kind"].as_str() != Some("question") {
            continue;
        }
        let Some(sid) = card["refs"]["sessionId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if card["refs"]["replyMessageId"]
            .as_str()
            .is_some_and(|s| !s.is_empty())
        {
            continue;
        }
        if let Some(sess) = sessions_by_id.get(sid)
            && TERMINAL_SESSION_STATUSES.contains(&sess.status.as_str())
        {
            continue;
        }
        all_cards.push(card.clone());
    }

    let mut items = Vec::new();
    for card in all_cards {
        if card["resolvedState"].as_str() == Some("resolved") {
            continue;
        }
        let Some(actions) = card["actions"].as_array() else {
            continue;
        };
        if actions.is_empty() {
            continue;
        }
        let Some(card_id) = card["cardId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let reply_msg_id = card["refs"]["replyMessageId"].as_str();
        let message = reply_msg_id.and_then(|rid| {
            replies
                .iter()
                .copied()
                .find(|m| m["id"].as_str().or_else(|| m["messageId"].as_str()) == Some(rid))
        });
        let card_approval_id = card["refs"]["approvalId"].as_str();
        let approval = card_approval_id.and_then(|aid| {
            pending_approvals
                .iter()
                .copied()
                .find(|a| a["approvalId"].as_str() == Some(aid))
        });

        let kind = match card["kind"].as_str().unwrap_or("") {
            "question" => AttentionKind::Question,
            "confirm_result" => AttentionKind::Confirmation,
            _ => AttentionKind::Approval,
        };
        let raw_title = message
            .and_then(|m| {
                m["question"]["prompt"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| m["questionContext"].as_str().filter(|s| !s.is_empty()))
                    .or_else(|| m["content"].as_str().filter(|s| !s.is_empty()))
            })
            .or_else(|| card["content"].as_str().filter(|s| !s.is_empty()))
            .unwrap_or("");
        let title: String = raw_title.chars().take(2000).collect();

        let created_at = message
            .and_then(|m| m["createdAt"].as_str().filter(|s| !s.is_empty()))
            .or_else(|| approval.and_then(|a| a["createdAt"].as_str().filter(|s| !s.is_empty())))
            .map(str::to_owned);
        let expires_at = message
            .and_then(|m| {
                m["question"]["expiresAt"]
                    .as_str()
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| approval.and_then(|a| a["deadlineAt"].as_str().filter(|s| !s.is_empty())))
            .map(str::to_owned);
        let message_id = message
            .and_then(|m| m["id"].as_str().filter(|s| !s.is_empty()))
            .map(str::to_owned);
        let session_id = card["refs"]["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        items.push(AttentionItem {
            id: card_id.to_owned(),
            workspace_id: profile.workspace_id.clone(),
            bot_name: profile.display_name.clone(),
            kind,
            title,
            created_at,
            expires_at,
            message_id,
            session_id,
            card: Some(card),
        });
    }

    for session in sessions {
        if session.completion_review_required && !pending_sessions.contains(&session.session_id) {
            items.push(AttentionItem {
                id: format!("completion:{}", session.session_id),
                workspace_id: profile.workspace_id.clone(),
                bot_name: profile.display_name.clone(),
                kind: AttentionKind::Confirmation,
                title: session.title.clone(),
                created_at: None,
                expires_at: None,
                message_id: None,
                session_id: Some(session.session_id.clone()),
                card: None,
            });
        }
    }

    // Deduplicate preserving last entry for each `id`, matching JS `Map` insertion.
    let mut index_by_id: HashMap<String, usize> = HashMap::new();
    let mut deduped: Vec<AttentionItem> = Vec::with_capacity(items.len());
    for item in items {
        if let Some(&pos) = index_by_id.get(&item.id) {
            deduped[pos] = item;
        } else {
            index_by_id.insert(item.id.clone(), deduped.len());
            deduped.push(item);
        }
    }
    deduped
}

fn session_in_current_list(session: &BotListSession) -> Option<bool> {
    if let Some(ref follow_up) = session.follow_up {
        if follow_up.reason == "obligation_indexed" {
            return None;
        }
        return Some(follow_up.in_current_list);
    }
    Some(
        !TERMINAL_SESSION_STATUSES.contains(&session.status.as_str()) && session.status != "paused",
    )
}

fn active_session_rank(session: &BotListSession) -> u8 {
    if let Some(ref follow_up) = session.follow_up {
        if follow_up.owner == "user" {
            return 0;
        }
        if follow_up.reason == "verification_failed" {
            return 1;
        }
    }
    match session.status.as_str() {
        "waiting_user" => 0,
        "failed" => 1,
        "result_ready" => 2,
        "verifying" => 3,
        "running" | "starting" => 4,
        "waiting_agent" | "stopping" | "awaiting_outcome" => 5,
        "queued" => 6,
        _ => 7,
    }
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
    let mut active_sessions: Vec<BotListSession> = Vec::new();
    let mut history_session_total: usize = 0;
    for session in sessions {
        match session_in_current_list(session) {
            Some(true) => active_sessions.push(session.clone()),
            Some(false) => history_session_total += 1,
            None => {}
        }
    }
    active_sessions.sort_by(|a, b| {
        active_session_rank(a)
            .cmp(&active_session_rank(b))
            .then_with(|| {
                let ta = a.updated_at.as_deref().and_then(parse_iso_ms).unwrap_or(0);
                let tb = b.updated_at.as_deref().and_then(parse_iso_ms).unwrap_or(0);
                tb.cmp(&ta)
            })
    });
    let active_session_total = active_sessions.len();
    active_sessions.truncate(20);
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
        .filter_map(|a| {
            a.expires_at
                .as_deref()
                .and_then(|s| parse_iso_ms(s).map(|ms| (ms, s)))
        })
        .min_by_key(|(ms, _)| *ms)
        .map(|(_, s)| s.to_owned());
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
        active_sessions,
        active_session_total,
        history_session_total,
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

#[derive(Debug, Clone)]
pub struct BotRowProjection {
    pub item: BotListItem,
    pub attention: Vec<AttentionItem>,
    pub titles: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct BotDetail {
    pub item: BotListItem,
    pub path: String,
    pub profile: BotProfile,
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

    pub fn read_cursor_record(&self, workspace_id: &str) -> Option<(String, Option<String>)> {
        let file = self.read_cursor_file(workspace_id).ok()?;
        let raw = fs::read_to_string(file).ok()?;
        let parsed: Value = serde_json::from_str(&raw).ok()?;
        let at = parsed["at"].as_str().filter(|s| !s.is_empty())?.to_owned();
        let message_id = parsed["messageId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        Some((at, message_id))
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

    fn summary_messages_for_profile(&self, profile: &BotProfile) -> Vec<Value> {
        self.summary_messages(profile, self.conversations.indexed_full_message_reader())
    }

    fn summary_messages(
        &self,
        profile: &BotProfile,
        read: impl FnOnce(&str) -> Result<Option<Vec<Value>>, StoreError>,
    ) -> Vec<Value> {
        let Some(conv_id) = profile
            .agent_conversation_id
            .as_deref()
            .filter(|s| !s.is_empty())
        else {
            return Vec::new();
        };
        if let Ok(Some(messages)) = read(conv_id) {
            messages
        } else {
            self.conversations
                .read_committed(conv_id, None, 8 * 1024 * 1024)
                .map(|snap| snap.history.messages)
                .unwrap_or_default()
        }
    }

    fn workspace_path(&self, workspace_id: &str) -> String {
        self.registry
            .diagnostic_snapshot()
            .ok()
            .and_then(|rows| rows.into_iter().find(|e| e.workspace_id == workspace_id))
            .map(|e| e.path)
            .unwrap_or_default()
    }

    fn project_row(
        &self,
        profile: BotProfile,
        messages: &[Value],
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
        now_ms: i64,
    ) -> BotRowProjection {
        let workspace_id = profile.workspace_id.clone();
        let last_msg = messages
            .iter()
            .rev()
            .find(|m| is_visible_bot_message(m) && message_kind(m) != "agent_activity")
            .map(project_bot_list_message);
        let sessions = sessions_by_workspace
            .get(&workspace_id)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let approvals = self
            .approvals
            .list(Some(&workspace_id), None)
            .unwrap_or_default();
        let resolutions =
            cards::read_card_resolutions(&self.data_home, &workspace_id).unwrap_or_default();
        let waiting_sessions: Vec<&BotListSession> = sessions
            .iter()
            .filter(|s| s.status == "waiting_user")
            .collect();
        let has_open_reply_question = project_reply_questions(messages, now_ms)
            .values()
            .any(|st| st.state == QuestionState::Open);
        let queued = if has_open_reply_question || !waiting_sessions.is_empty() {
            InputQueue::new(&self.data_home)
                .list_unconsumed_meta(&workspace_id)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let task_question_cards = cards::project_waiting_user_question_cards_with_queued(
            &self.data_home,
            &workspace_id,
            messages,
            &queued,
            &waiting_sessions,
            &resolutions,
        );
        let attention = project_bot_attention_with_cards_and_queued(
            &profile,
            messages,
            &queued,
            sessions,
            &approvals,
            &task_question_cards,
            &resolutions,
            now_ms,
        );
        let cursor = self.read_cursor(&workspace_id);
        let item = project_bot_list_item(
            profile,
            last_msg.as_ref(),
            sessions,
            &attention,
            cursor.as_deref(),
        );
        let titles = sessions
            .iter()
            .filter(|s| !s.title.is_empty())
            .map(|s| s.title.clone())
            .collect();
        BotRowProjection {
            item,
            attention,
            titles,
        }
    }

    /// Parity `markRead` for Bot conversations: tracks `{ at, messageId }` idempotently
    /// based on the latest visible bot message, avoiding disk writes when unchanged.
    pub fn mark_read_bot(&self, workspace_id: &str) -> Result<MarkReadResult, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let messages = self.summary_messages_for_profile(&profile);
        let visible: Vec<&Value> = messages
            .iter()
            .filter(|m| is_visible_bot_message(m))
            .collect();
        let last = visible.last().copied();
        let message_id = last
            .and_then(|m| m["id"].as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let last_at = last
            .and_then(|m| m["createdAt"].as_str().or_else(|| m["at"].as_str()))
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let current = self.read_cursor_record(workspace_id);
        let at = last_at
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|(cat, cmid)| (cmid == &message_id).then(|| cat.clone()))
            })
            .unwrap_or_else(now_iso);
        if current
            .as_ref()
            .is_some_and(|(cat, cmid)| cat == &at && cmid == &message_id)
        {
            return Ok(MarkReadResult {
                at,
                message_id,
                changed: false,
            });
        }
        let file = self.read_cursor_file(workspace_id)?;
        let mut body = serde_json::to_string(&json!({
            "at": at,
            "messageId": message_id,
        }))
        .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&file, body.as_bytes())?;
        Ok(MarkReadResult {
            at,
            message_id,
            changed: true,
        })
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
            .filter(|p| p.is_active())
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let familiarize_offer = (before_message_id.is_none() && profile.familiarize.is_none())
            .then(default_familiarize_offer);
        let Some(conv_id) = profile.agent_conversation_id.as_deref() else {
            return Ok(InteractionPage {
                messages: Vec::new(),
                next_cursor: None,
                source_version: "0".to_owned(),
                familiarize_offer,
            });
        };
        let (all_messages, source_version) =
            match self
                .conversations
                .read_committed(conv_id, None, 8 * 1024 * 1024)
            {
                Ok(s) => (s.history.messages, s.source_revision),
                Err(peer_store::StoreError::NotFound) => {
                    return Ok(InteractionPage {
                        messages: Vec::new(),
                        next_cursor: None,
                        source_version: "0".to_owned(),
                        familiarize_offer,
                    });
                }
                Err(peer_store::StoreError::HistoryLimit) => {
                    match self
                        .conversations
                        .read_conversation_window(conv_id, None, None, true)
                    {
                        Ok(Some(page)) => {
                            let msgs = page["window"].as_array().cloned().unwrap_or_default();
                            let rev = page["meta"]["contentRevision"]
                                .as_u64()
                                .map(|r| format!("window-rev-{r}"))
                                .unwrap_or_else(|| format!("window-len-{}", msgs.len()));
                            (msgs, rev)
                        }
                        Ok(None) => {
                            return Ok(InteractionPage {
                                messages: Vec::new(),
                                next_cursor: None,
                                source_version: "0".to_owned(),
                                familiarize_offer,
                            });
                        }
                        Err(e) => return Err(e.into()),
                    }
                }
                Err(e) => return Err(e.into()),
            };
        let visible: Vec<_> = all_messages
            .iter()
            .filter(|message| is_visible_bot_message(message))
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
        let selected = &visible[start..end];
        let turn_ids: HashSet<_> = selected
            .iter()
            .filter_map(|row| row["turnId"].as_str())
            .collect();
        let turns = all_messages
            .iter()
            .filter_map(|row| {
                let id = row["id"].as_str()?;
                (message_kind(row) == "agent_turn" && turn_ids.contains(id)).then_some((id, row))
            })
            .collect::<HashMap<_, _>>();
        let mut page = Vec::with_capacity(selected.len() + turns.len());
        let mut included = HashSet::new();
        for message in selected {
            page.push((*message).clone());
            let Some(turn_id) = message["turnId"].as_str().filter(|id| included.insert(*id)) else {
                continue;
            };
            let Some(turn) = turns.get(turn_id) else {
                continue;
            };
            let mut turn = (*turn).clone();
            crate::runner::hydrate_agent_turn_record(&self.data_home, workspace_id, &mut turn);
            if !turn["publicUpdates"]
                .as_array()
                .is_some_and(|updates| !updates.is_empty())
            {
                continue;
            }
            // Keep the linked public narration in the interaction page while
            // tool diagnostics remain available through processFor only.
            page.push(json!({
                "id": turn_id,
                "role": "assistant",
                "kind": "agent_turn",
                "content": "",
                "turnId": turn_id,
                "turnKind": turn["turnKind"],
                "createdAt": turn["createdAt"],
                "replyTo": turn["replyTo"],
                "displayContract": turn["displayContract"],
                "publicUpdates": turn["publicUpdates"],
                "meta": { "workId": turn["meta"]["workId"] },
            }));
        }
        let next_cursor = if start > 0 {
            selected
                .first()
                .and_then(|m| m["id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };
        Ok(InteractionPage {
            messages: page,
            next_cursor,
            source_version,
            familiarize_offer,
        })
    }

    fn read_parent_messages(&self, conv_id: Option<&str>) -> Result<Vec<Value>, ProjectError> {
        let Some(cid) = conv_id.filter(|s| !s.is_empty()) else {
            return Ok(Vec::new());
        };
        match self
            .conversations
            .read_committed(cid, None, 8 * 1024 * 1024)
        {
            Ok(s) => Ok(s.history.messages),
            Err(peer_store::StoreError::NotFound) => Ok(Vec::new()),
            Err(peer_store::StoreError::HistoryLimit) => {
                match self
                    .conversations
                    .read_conversation_window(cid, None, None, true)
                {
                    Ok(Some(page)) => Ok(page["window"].as_array().cloned().unwrap_or_default()),
                    Ok(None) => Ok(Vec::new()),
                    Err(e) => Err(e.into()),
                }
            }
            Err(e) => Err(e.into()),
        }
    }

    fn resolve_process_messages(
        messages: Vec<Value>,
        cards: &[Value],
        process_for: &str,
    ) -> (Vec<Value>, Option<String>) {
        let card = cards
            .iter()
            .find(|c| c["cardId"].as_str() == Some(process_for));
        let card_turn_id = card
            .and_then(|c| c["refs"]["turnId"].as_str())
            .filter(|s| !s.is_empty());
        let card_kind = card.and_then(|c| c["kind"].as_str());

        let target_idx = messages
            .iter()
            .position(|m| m["id"].as_str() == Some(process_for) && message_kind(m) != "agent_turn")
            .or_else(|| {
                card_turn_id.and_then(|tid| {
                    messages.iter().position(|m| {
                        m["turnId"].as_str() == Some(tid)
                            && m["card"].as_str().is_some()
                            && m["card"].as_str() == card_kind
                    })
                })
            })
            .or_else(|| {
                messages.iter().rposition(|m| {
                    m["turnId"].as_str() == Some(process_for) && message_kind(m) != "agent_turn"
                })
            })
            .or_else(|| {
                messages
                    .iter()
                    .position(|m| m["id"].as_str() == Some(process_for))
            });

        let mut turn_idx = target_idx.and_then(|ti| {
            messages[ti]["turnId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .and_then(|tid| {
                    messages.iter().position(|m| {
                        m["id"].as_str() == Some(tid) && message_kind(m) == "agent_turn"
                    })
                })
        });

        if let Some(ti) = target_idx
            && message_kind(&messages[ti]) == "agent_reply"
            && messages[ti]["turnId"].as_str().is_none_or(str::is_empty)
        {
            turn_idx = None;
            for (idx, m) in messages.iter().enumerate() {
                if idx == ti {
                    break;
                }
                let k = message_kind(m);
                if k == "user_input" {
                    turn_idx = None;
                } else if k == "agent_turn" {
                    turn_idx = Some(idx);
                }
            }
        }

        let process_message_id =
            target_idx.and_then(|ti| messages[ti]["id"].as_str().map(str::to_owned));
        let narrowed = messages
            .into_iter()
            .enumerate()
            .filter(|(idx, _)| Some(*idx) == target_idx || Some(*idx) == turn_idx)
            .map(|(_, m)| m)
            .collect();
        (narrowed, process_message_id)
    }

    fn decorate_page_message(
        &self,
        message: &Value,
        workspace_id: &str,
        by_card: &HashMap<&str, &Value>,
        by_reply: &HashMap<&str, Vec<&Value>>,
        sessions_cache: &mut Option<HashMap<String, Value>>,
    ) -> Value {
        let mut out = message.clone();
        let kind = message_kind(message);
        if kind == "agent_turn" {
            crate::runner::hydrate_agent_turn_record(&self.data_home, workspace_id, &mut out);
        }
        let Some(obj) = out.as_object_mut() else {
            return out;
        };
        let msg_id = message["id"].as_str().unwrap_or("");

        let has_sources = message["sources"].as_array().is_some_and(|a| !a.is_empty());
        let has_states = message["meta"]
            .get("sessionStates")
            .is_some_and(|v| !v.is_null() && v != false);
        if kind == "agent_reply" && (has_sources || has_states) {
            let map = sessions_cache.get_or_insert_with(|| {
                crate::session_projection::list_sessions_projected(
                    &self.data_home,
                    Some(workspace_id),
                    None,
                    None,
                    None,
                    None,
                )
                .into_iter()
                .filter_map(|s| {
                    let id = s["sessionId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)?;
                    Some((id, s))
                })
                .collect()
            });
            let src_arr = message["sources"]
                .as_array()
                .or_else(|| message["meta"]["sources"].as_array());
            let mut seen_sids = HashSet::new();
            let mut refreshed_states = Vec::new();
            if let Some(arr) = src_arr {
                for sid in arr
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    if !seen_sids.insert(sid) {
                        continue;
                    }
                    if refreshed_states.len() >= 20 {
                        break;
                    }
                    if let Some(session) = map.get(sid) {
                        let mut st = serde_json::Map::new();
                        st.insert("sessionId".into(), json!(sid));
                        st.insert("status".into(), session["status"].clone());
                        if let Some(sr) =
                            session["sourceRevision"].as_str().filter(|s| !s.is_empty())
                        {
                            st.insert("sourceRevision".into(), json!(sr));
                        }
                        if let Some(orv) = session["observationRevision"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                        {
                            st.insert("observationRevision".into(), json!(orv));
                        }
                        refreshed_states.push(Value::Object(st));
                    }
                }
            }
            let mut meta_obj = message["meta"].as_object().cloned().unwrap_or_default();
            meta_obj.insert("sessionStates".into(), Value::Array(refreshed_states));
            obj.insert("meta".into(), Value::Object(meta_obj));
        }

        let has_cards = message
            .get("cards")
            .is_some_and(|v| !v.is_null() && v != false);
        let reply_cards = if kind == "agent_reply" {
            by_reply.get(msg_id)
        } else {
            None
        };
        if has_cards || reply_cards.is_some() {
            let mut merged: Vec<Value> = Vec::new();
            let mut index_by_id: HashMap<String, usize> = HashMap::new();
            if let Some(existing) = message["cards"].as_array() {
                for c in existing {
                    let Some(cid) = c["cardId"].as_str() else {
                        continue;
                    };
                    let val = by_card.get(cid).copied().unwrap_or(c).clone();
                    if let Some(&pos) = index_by_id.get(cid) {
                        merged[pos] = val;
                    } else {
                        index_by_id.insert(cid.to_owned(), merged.len());
                        merged.push(val);
                    }
                }
            }
            if let Some(rcs) = reply_cards {
                for &rc in rcs {
                    let Some(cid) = rc["cardId"].as_str() else {
                        continue;
                    };
                    if let Some(&pos) = index_by_id.get(cid) {
                        merged[pos] = rc.clone();
                    } else {
                        index_by_id.insert(cid.to_owned(), merged.len());
                        merged.push(rc.clone());
                    }
                }
            }
            obj.insert("cards".into(), Value::Array(merged));
        }

        out
    }

    /// Canonical readConversation entry point serving default paginated view, `view: "cards"`,
    /// `view: "interactions"` (coordination-isolated), and `processFor` trace drilldown.
    pub fn read_conversation(&self, workspace_id: &str, opts: &ReadConversationOptions) -> Value {
        let Some(profile) = self.profiles.read(workspace_id).filter(|p| p.is_active()) else {
            return json!({ "ok": false, "code": "NOT_FOUND" });
        };

        let before = opts.before.as_deref().filter(|s| !s.is_empty());
        if let Some(pf) = opts.process_for.as_deref()
            && (pf.trim().is_empty() || pf.encode_utf16().count() > 500 || opts.presentation_only)
        {
            return json!({ "ok": false, "code": "INVALID_INPUT" });
        }

        if opts.process_for.is_none() && opts.view.as_deref() == Some("interactions") {
            let size = opts.limit.filter(|&l| l > 0).unwrap_or(50).min(100);
            return match self.read_interactions(workspace_id, size, before) {
                Ok(page) => {
                    let mut out = json!({
                        "ok": true,
                        "messages": page.messages,
                        "nextCursor": page.next_cursor,
                        "sourceVersion": page.source_version,
                    });
                    if let Some(offer) = page.familiarize_offer {
                        out.as_object_mut()
                            .unwrap()
                            .insert("familiarizeOffer".into(), json!(offer));
                    }
                    out
                }
                Err(err) => json!({ "ok": false, "code": err.code }),
            };
        }

        let parent_messages =
            match self.read_parent_messages(profile.agent_conversation_id.as_deref()) {
                Ok(msgs) => msgs,
                Err(err) => return json!({ "ok": false, "code": err.code }),
            };

        if opts.process_for.is_none() && opts.view.as_deref() == Some("cards") {
            return match cards::project_workspace_cards(
                &self.data_home,
                workspace_id,
                &parent_messages,
                &now_iso(),
            ) {
                Ok(projected) => json!({ "ok": true, "cards": projected }),
                Err(err) => json!({ "ok": false, "cards": [], "code": err.code }),
            };
        }

        let projected_cards = match cards::project_workspace_cards(
            &self.data_home,
            workspace_id,
            &parent_messages,
            &now_iso(),
        ) {
            Ok(c) => c,
            Err(err) => return json!({ "ok": false, "code": err.code }),
        };

        let mut process_message_id: Option<String> = None;
        let filtered: Vec<Value> = if let Some(pf) = opts.process_for.as_deref() {
            let (narrowed, pmid) =
                Self::resolve_process_messages(parent_messages, &projected_cards, pf);
            process_message_id = pmid;
            narrowed
        } else {
            let allowed: Option<HashSet<&str>> = opts
                .kinds
                .as_ref()
                .map(|ks| ks.iter().map(String::as_str).collect());
            parent_messages
                .into_iter()
                .filter(|m| {
                    if let Some(set) = allowed.as_ref() {
                        set.contains(message_kind(m))
                    } else {
                        is_visible_bot_message(m) || message_kind(m) == "agent_turn"
                    }
                })
                .collect()
        };

        let size = opts.limit.filter(|&l| l > 0).unwrap_or(50).min(100);
        let mut start = 0usize;
        let mut end = filtered.len();
        if let Some(cursor) = before {
            let idx = filtered
                .iter()
                .position(|m| m["id"].as_str() == Some(cursor));
            if opts.latest {
                end = idx.unwrap_or(filtered.len());
            } else {
                start = idx.map_or(0, |i| i + 1);
            }
        }
        if opts.latest {
            start = end.saturating_sub(size);
        }

        let mut by_card: HashMap<&str, &Value> = HashMap::new();
        let mut by_reply: HashMap<&str, Vec<&Value>> = HashMap::new();
        for card in &projected_cards {
            if let Some(cid) = card["cardId"].as_str().filter(|s| !s.is_empty()) {
                by_card.insert(cid, card);
            }
            if let Some(rid) = card["refs"]["replyMessageId"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                by_reply.entry(rid).or_default().push(card);
            }
        }

        let slice_end = if opts.latest {
            end
        } else {
            (start + size).min(filtered.len())
        };
        let mut sessions_cache: Option<HashMap<String, Value>> = None;
        let mut page: Vec<Value> = filtered[start..slice_end]
            .iter()
            .map(|m| {
                self.decorate_page_message(
                    m,
                    workspace_id,
                    &by_card,
                    &by_reply,
                    &mut sessions_cache,
                )
            })
            .collect();

        let next_cursor: Value = if opts.latest {
            if start > 0 {
                page.first()
                    .and_then(|m| m["id"].as_str())
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null)
            } else {
                Value::Null
            }
        } else if start + size < filtered.len() {
            page.last()
                .and_then(|m| m["id"].as_str())
                .map(|s| json!(s))
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };

        if before.is_none() && opts.process_for.is_none() {
            let mut present: HashSet<&str> = HashSet::new();
            for m in &filtered {
                if let Some(arr) = m["cards"].as_array() {
                    for c in arr {
                        if let Some(cid) = c["cardId"].as_str() {
                            present.insert(cid);
                        }
                    }
                }
            }
            for card in &projected_cards {
                let cid = card["cardId"].as_str().unwrap_or("");
                let has_reply = card["refs"]["replyMessageId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty());
                if !has_reply
                    && !present.contains(cid)
                    && card["resolvedState"].as_str() != Some("resolved")
                {
                    page.push(json!({
                        "id": cid,
                        "role": "assistant",
                        "kind": "system_card",
                        "content": "",
                        "cards": [card],
                    }));
                }
            }
        }

        let active_reply_question_id = projected_cards
            .iter()
            .find(|c| {
                c["kind"].as_str() == Some("question")
                    && c["resolvedState"].as_str() != Some("resolved")
                    && c["refs"]["replyMessageId"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
            })
            .and_then(|c| c["refs"]["replyMessageId"].as_str())
            .map(|s| json!(s))
            .unwrap_or(Value::Null);

        let mut out = json!({
            "ok": true,
            "messages": page,
            "nextCursor": next_cursor,
            "activeReplyQuestionId": active_reply_question_id,
        });
        if let Some(map) = out.as_object_mut() {
            if opts.process_for.is_some() {
                map.insert("processMessageId".into(), json!(process_message_id));
            } else if before.is_none() && profile.familiarize.is_none() {
                map.insert(
                    "familiarizeOffer".into(),
                    json!(default_familiarize_offer()),
                );
            }
        }
        out
    }

    pub fn project_rows(
        &self,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
    ) -> Vec<BotRowProjection> {
        self.project_rows_with_history(sessions_by_workspace, |_, _| {})
    }

    /// Let search reuse the same authorized history that was read for each row.
    pub fn project_rows_with_history(
        &self,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
        mut observe: impl FnMut(&str, Vec<Value>),
    ) -> Vec<BotRowProjection> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let reader = self.conversations.indexed_full_message_reader();
        let mut out = Vec::new();
        for workspace_id in self.profiles.list_workspace_ids() {
            let Some(profile) = self.profiles.read(&workspace_id) else {
                continue;
            };
            if !profile.is_active() {
                continue;
            }
            let messages = self.summary_messages(&profile, &reader);
            out.push(self.project_row(profile, &messages, sessions_by_workspace, now_ms));
            observe(&workspace_id, messages);
        }
        out
    }

    pub fn filter_projected_rows(
        rows: Vec<BotRowProjection>,
        query: Option<&str>,
        needs_you_only: bool,
    ) -> (Vec<BotListItem>, Vec<BotListItem>) {
        let q = query
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty());
        let mut catalog = Vec::with_capacity(rows.len());
        let mut matched = Vec::new();
        for row in rows {
            let needs_you_ok = !needs_you_only || row.item.state.needs_you > 0;
            let text_ok = match q.as_ref() {
                None => true,
                Some(text) => {
                    row.item.profile.display_name.to_lowercase().contains(text)
                        || row.item.preview.to_lowercase().contains(text)
                        || row.titles.iter().any(|t| t.to_lowercase().contains(text))
                }
            };
            if needs_you_ok && text_ok {
                matched.push(row.item.clone());
            }
            catalog.push(row.item);
        }
        (sort_bot_list(matched), sort_bot_list(catalog))
    }

    pub fn query_items(
        &self,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
        query: Option<&str>,
        needs_you_only: bool,
    ) -> Vec<BotListItem> {
        let rows = self.project_rows(sessions_by_workspace);
        Self::filter_projected_rows(rows, query, needs_you_only).0
    }

    pub fn list(
        &self,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
    ) -> Vec<BotListItem> {
        self.query_items(sessions_by_workspace, None, false)
    }

    pub fn get_bot(
        &self,
        workspace_id: &str,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
    ) -> Result<BotDetail, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        let Some(profile) = self.profiles.read(workspace_id) else {
            return Err(ProjectError::code("NOT_FOUND"));
        };
        if !profile.is_active() {
            return Err(ProjectError::code("ARCHIVED"));
        }
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let messages = self.summary_messages_for_profile(&profile);
        let row = self.project_row(profile.clone(), &messages, sessions_by_workspace, now_ms);
        Ok(BotDetail {
            item: row.item,
            path: self.workspace_path(workspace_id),
            profile,
        })
    }

    pub fn list_attention(
        &self,
        workspace_id: Option<&str>,
        sessions_by_workspace: &HashMap<String, Vec<BotListSession>>,
    ) -> Result<Vec<AttentionItem>, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        if let Some(ws) = workspace_id {
            if !is_valid_workspace_id(ws) {
                return Err(ProjectError::code("NOT_FOUND"));
            }
            let Some(profile) = self.profiles.read(ws).filter(BotProfile::is_active) else {
                return Err(ProjectError::code("NOT_FOUND"));
            };
            let messages = self.summary_messages_for_profile(&profile);
            return Ok(self
                .project_row(profile, &messages, sessions_by_workspace, now_ms)
                .attention);
        }
        Ok(self
            .project_rows(sessions_by_workspace)
            .into_iter()
            .flat_map(|row| row.attention)
            .collect())
    }

    pub fn find_active_bot_for_path(&self, workspace_path: &str) -> Option<BotProfile> {
        let entry = self.registry.find_by_path(workspace_path).ok()??;
        let profile = self.profiles.read(&entry.workspace_id)?;
        profile.is_active().then_some(profile)
    }

    pub fn question_state(&self, workspace_id: &str, question_id: &str) -> Option<QuestionState> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)?;
        let conv_id = profile.agent_conversation_id?;
        let snap = self
            .conversations
            .read_committed(&conv_id, None, 8 * 1024 * 1024)
            .ok()?;
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let states = project_reply_questions(&snap.history.messages, now_ms);
        let state = states.get(question_id).map(|s| s.state)?;
        if state == QuestionState::Open {
            let queued = InputQueue::new(&self.data_home)
                .list_unconsumed_meta(workspace_id)
                .unwrap_or_default();
            if !queued.is_empty() {
                let merged =
                    project_reply_questions_with_queued(&snap.history.messages, &queued, now_ms);
                return merged.get(question_id).map(|s| s.state);
            }
        }
        Some(state)
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
        let mut histories = Vec::new();
        let rows = directory.project_rows_with_history(&HashMap::new(), |id, messages| {
            histories.push((id.to_owned(), messages));
        });
        assert_eq!(
            rows[0].item,
            directory.get_bot("ws-alpha", &HashMap::new()).unwrap().item
        );
        assert_eq!(rows[0].attention.len(), 1);
        assert_eq!(histories[0].0, "ws-alpha");
        assert_eq!(histories[0].1[0]["id"], "reply-1");

        directory
            .mark_read("ws-alpha", Some("2026-11-19T01:06:00.000Z"))
            .unwrap();
        let listed2 = directory.list(&HashMap::new());
        assert_eq!(listed2[0].state.unread, 0);
        assert_eq!(listed2[0].state.needs_you, 1);
    }

    #[test]
    fn interaction_page_retains_linked_public_progress_without_tool_diagnostics() {
        let home = tempdir().unwrap();
        let project = tempdir().unwrap();
        let host = crate::NativeProjectHost::new(home.path(), "test", None).unwrap();
        let (workspace, profile) = host.bind_workspace(project.path(), None).unwrap();
        let conversation = profile.agent_conversation_id.unwrap();
        let at = "2026-11-19T01:00:00.000Z";
        for row in [
            json!({ "id": "input-1", "role": "user", "kind": "user_input", "content": "Check the result", "createdAt": at }),
            json!({ "id": "turn-1", "role": "assistant", "kind": "agent_turn", "content": "", "createdAt": at,
                "publicUpdates": [{ "id": "progress", "text": "Checking the repository" }],
                "rounds": [{ "text": "internal tool diagnostic" }] }),
            json!({ "id": "failed-1", "role": "assistant", "kind": "system_card", "turnId": "turn-1", "content": "Disconnected", "createdAt": at }),
        ] {
            host.conversations()
                .append_message_idempotent(&conversation, &row, at, None)
                .unwrap();
        }
        let page = host
            .directory()
            .read_interactions(&workspace.workspace_id, 1, None)
            .unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("failed-1"));
        assert_eq!(page.messages.len(), 2);
        assert_eq!(
            page.messages[1]["publicUpdates"][0]["text"],
            "Checking the repository"
        );
        assert!(page.messages[1].get("rounds").is_none());
        let older = host
            .directory()
            .read_interactions(&workspace.workspace_id, 1, page.next_cursor.as_deref())
            .unwrap();
        assert_eq!(older.messages.len(), 1);
        assert_eq!(older.messages[0]["id"], "input-1");
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

    #[test]
    fn compaction_is_hidden_and_question_lifecycle_handles_card_ids_and_reply_superseding() {
        let now_ms = 1_700_000_000_000i64;
        let messages = vec![
            json!({
                "id": "compact-1",
                "role": "user",
                "content": "Summary",
                "_compaction": {"method": "structured", "summary": "Summary"}
            }),
            json!({
                "id": "turn-1",
                "role": "assistant",
                "kind": "agent_turn",
                "content": "",
                "rounds": []
            }),
            json!({
                "id": "reply-q1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Pick A or B?",
                "question": {"options": ["A", "B"]}
            }),
            json!({
                "id": "in-1",
                "role": "user",
                "kind": "user_input",
                "content": "A",
                "answerTo": "card:question:reply:reply-q1"
            }),
            json!({
                "id": "reply-q2",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Pick C or D?",
                "question": {"options": ["C", "D"]}
            }),
            json!({
                "id": "reply-later",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Never mind, proceeding."
            }),
            json!({
                "id": "reply-q3",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Already flagged answered",
                "question": {"options": ["X"], "answered": true}
            }),
            json!({
                "id": "reply-q4",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Raw target test",
                "question": {"options": ["Y"]}
            }),
            json!({
                "id": "in-2",
                "role": "user",
                "kind": "user_input",
                "content": "Y",
                "answerTo": "reply-q4"
            }),
        ];

        assert!(!is_visible_bot_message(&messages[0]));
        assert!(!is_visible_bot_message(&messages[1]));
        assert!(is_visible_bot_message(&messages[2]));

        let states = project_reply_questions(&messages, now_ms);
        assert_eq!(states["reply-q1"].state, QuestionState::Answered);
        assert_eq!(states["reply-q2"].state, QuestionState::Superseded);
        assert_eq!(states["reply-q3"].state, QuestionState::Answered);
        assert_eq!(states["reply-q4"].state, QuestionState::Answered);
    }

    #[test]
    fn mark_read_bot_is_idempotent_and_tracks_latest_visible_message() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        let convs = ConversationStore::new(dir.path());
        let created_at = "2026-11-19T02:00:00.000Z";
        let conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: Some("conv-mark-read"),
                    title: "Reader",
                    workspace_id: "ws-mr",
                    workspace_path: Some("/tmp/mr"),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at,
                },
                None,
                None,
            )
            .unwrap();
        let conv_id = conv["id"].as_str().unwrap();
        profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-mr",
                display_name: "Reader",
                managed: false,
                agent_conversation_id: conv_id,
                avatar_salt: "",
            })
            .unwrap();
        convs
            .append_classic_message(
                conv_id,
                &json!({
                    "id": "msg-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "First reply",
                    "createdAt": "2026-11-19T02:01:00.000Z"
                }),
            )
            .unwrap();

        let directory = BotDirectory::new(dir.path());
        let first = directory.mark_read_bot("ws-mr").unwrap();
        assert_eq!(
            first,
            MarkReadResult {
                at: "2026-11-19T02:01:00.000Z".into(),
                message_id: Some("msg-1".into()),
                changed: true,
            }
        );

        let second = directory.mark_read_bot("ws-mr").unwrap();
        assert!(!second.changed);
        assert_eq!(second.at, "2026-11-19T02:01:00.000Z");
        assert_eq!(second.message_id.as_deref(), Some("msg-1"));

        convs
            .append_classic_message(
                conv_id,
                &json!({
                    "id": "msg-2",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Second reply",
                    "createdAt": "2026-11-19T02:02:00.000Z"
                }),
            )
            .unwrap();
        let third = directory.mark_read_bot("ws-mr").unwrap();
        assert!(third.changed);
        assert_eq!(third.at, "2026-11-19T02:02:00.000Z");
        assert_eq!(third.message_id.as_deref(), Some("msg-2"));

        assert_eq!(
            directory.mark_read_bot("missing").unwrap_err().code,
            "NOT_FOUND"
        );
        profiles.archive("ws-mr").unwrap();
        assert_eq!(
            directory.mark_read_bot("ws-mr").unwrap_err().code,
            "NOT_FOUND"
        );
    }

    #[test]
    fn query_get_and_list_attention_project_cards_session_titles_and_errors() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        let convs = ConversationStore::new(dir.path());
        let reg = ProjectRegistry::new(dir.path());
        let ws_dir = dir.path().join("repo-q");
        fs::create_dir_all(&ws_dir).unwrap();
        let entry = reg.register(ws_dir.to_str().unwrap(), None).unwrap();
        let ws_id = entry.workspace_id.clone();

        let at = "2026-11-22T01:00:00.000Z";
        let conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "QueryBot",
                    workspace_id: &ws_id,
                    workspace_path: Some(&entry.path),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: at,
                },
                None,
                None,
            )
            .unwrap();
        let conv_id = conv["id"].as_str().unwrap().to_owned();
        profiles
            .create(&CreateBotProfile {
                workspace_id: &ws_id,
                display_name: "AlphaBot",
                managed: false,
                agent_conversation_id: &conv_id,
                avatar_salt: "",
            })
            .unwrap();

        let child_conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "ChildTask",
                    workspace_id: &ws_id,
                    workspace_path: Some(&entry.path),
                    role: "work_session",
                    parent_conversation_id: Some(&conv_id),
                    mode: "goal",
                    created_at: at,
                },
                None,
                None,
            )
            .unwrap();
        let child_conv_id = child_conv["id"].as_str().unwrap().to_owned();
        convs
            .append_classic_message(
                &child_conv_id,
                &json!({
                    "id": "m-child-q",
                    "role": "assistant",
                    "segments": [{
                        "tool": "request_user_input",
                        "toolCallId": "q-1",
                        "args": { "question": "Deploy now?", "options": ["Yes", "Hold"] }
                    }]
                }),
            )
            .unwrap();

        convs
            .append_classic_message(
                &conv_id,
                &json!({
                    "id": "m-reply-q",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Choose env",
                    "createdAt": "2026-11-22T01:05:00.000Z",
                    "question": { "prompt": "Env?", "options": ["Prod", "Staging"], "expiresAt": "2099-01-01T00:00:00.000Z" }
                }),
            )
            .unwrap();

        let mut sessions_by_ws = HashMap::new();
        sessions_by_ws.insert(
            ws_id.clone(),
            vec![
                BotListSession {
                    session_id: "sess-wait".into(),
                    title: "UniqueMigrations".into(),
                    status: "waiting_user".into(),
                    updated_at: Some("2026-11-22T01:06:00.000Z".into()),
                    result_confirmation_required: None,
                    completion_review_required: false,
                    conversation_id: Some(child_conv_id),
                    queue_reason: None,
                    follow_up: None,
                    phase_label: None,
                    anchor_message_id: None,
                    plan_id: None,
                },
                BotListSession {
                    session_id: "sess-dep".into(),
                    title: "BlockedDeploy".into(),
                    status: "waiting_user".into(),
                    updated_at: Some("2026-11-22T01:04:00.000Z".into()),
                    result_confirmation_required: None,
                    completion_review_required: false,
                    conversation_id: None,
                    queue_reason: Some("dependency_failed".into()),
                    follow_up: None,
                    phase_label: None,
                    anchor_message_id: None,
                    plan_id: None,
                },
                BotListSession {
                    session_id: "sess-comp".into(),
                    title: "ManualReviewTask".into(),
                    status: "waiting_user".into(),
                    updated_at: Some("2026-11-22T01:03:00.000Z".into()),
                    result_confirmation_required: None,
                    completion_review_required: true,
                    conversation_id: None,
                    queue_reason: None,
                    follow_up: None,
                    phase_label: None,
                    anchor_message_id: None,
                    plan_id: None,
                },
            ],
        );

        let directory = BotDirectory::new(dir.path());
        // Session title matching in `query_items`
        let matched = directory.query_items(&sessions_by_ws, Some("uniquemig"), false);
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].workspace_id, ws_id);
        assert_eq!(
            matched[0].state.attention_expires_at.as_deref(),
            Some("2099-01-01T00:00:00.000Z")
        );

        let detail = directory.get_bot(&ws_id, &sessions_by_ws).unwrap();
        assert_eq!(detail.path, entry.path);
        assert_eq!(
            directory
                .get_bot("../bad", &sessions_by_ws)
                .unwrap_err()
                .code,
            "INVALID_WORKSPACE"
        );
        assert_eq!(
            directory
                .get_bot("missing-id", &sessions_by_ws)
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );

        let attn = directory
            .list_attention(Some(&ws_id), &sessions_by_ws)
            .unwrap();
        assert_eq!(attn.len(), 4);
        assert!(
            attn.iter()
                .any(|a| a.id == "card:question:reply:m-reply-q" && a.card.is_some())
        );
        assert!(
            attn.iter()
                .any(|a| a.id == "card:question:sess-wait:q-1" && a.card.is_some())
        );
        assert!(
            attn.iter()
                .any(|a| a.id == "card:question:sess-dep:dependency" && a.card.is_some())
        );
        assert!(
            attn.iter()
                .any(|a| a.id == "completion:sess-comp" && a.card.is_none())
        );

        // Dismiss reply question via cards.jsonl -> disappears from attention.
        let rt_dir = dir.path().join("project-runtime").join(&ws_id);
        fs::create_dir_all(&rt_dir).unwrap();
        fs::write(
            rt_dir.join("cards.jsonl"),
            "{\"cardId\":\"card:question:reply:m-reply-q\",\"resolvedState\":\"resolved\",\"at\":\"2026-11-22T01:07:00.000Z\"}\n",
        )
        .unwrap();
        let attn_after = directory
            .list_attention(Some(&ws_id), &sessions_by_ws)
            .unwrap();
        assert_eq!(attn_after.len(), 3);
        assert!(
            !attn_after
                .iter()
                .any(|a| a.id == "card:question:reply:m-reply-q")
        );

        assert_eq!(
            directory
                .list_attention(Some("missing"), &sessions_by_ws)
                .unwrap_err()
                .code,
            "NOT_FOUND"
        );

        profiles.archive(&ws_id).unwrap();
        assert_eq!(
            directory.get_bot(&ws_id, &sessions_by_ws).unwrap_err().code,
            "ARCHIVED"
        );
    }

    #[test]
    fn read_conversation_covers_default_cards_interactions_isolation_and_process_for() {
        let dir = tempdir().unwrap();
        let data_home = dir.path();
        let ws = "ws-read-conv";
        let convs = ConversationStore::new(data_home);
        let at = "2026-11-22T01:00:00.000Z";
        let conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: Some("conv-read-parent"),
                    title: "Read Conv Bot",
                    workspace_id: ws,
                    workspace_path: Some("/tmp/read-conv"),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: at,
                },
                None,
                None,
            )
            .unwrap();
        let conv_id = conv["id"].as_str().unwrap().to_owned();

        let profiles = BotProfileStore::new(data_home);
        let (mut profile, _) = profiles
            .create(&CreateBotProfile {
                workspace_id: ws,
                display_name: "ReadConvBot",
                managed: false,
                agent_conversation_id: &conv_id,
                avatar_salt: "",
            })
            .unwrap();
        profile.readme_offer = Some(json!({ "offered": true }));
        profiles.save(profile).unwrap();

        convs
            .append_classic_message(
                &conv_id,
                &json!({
                    "id": "u-1",
                    "role": "user",
                    "kind": "user_input",
                    "content": "Check status",
                    "createdAt": "2026-11-22T01:01:00.000Z",
                }),
            )
            .unwrap();
        convs
            .append_classic_message(
                &conv_id,
                &json!({
                    "id": "turn-1",
                    "role": "assistant",
                    "kind": "agent_turn",
                    "content": "",
                    "rounds": [{ "idx": 1 }],
                    "createdAt": "2026-11-22T01:02:00.000Z",
                }),
            )
            .unwrap();
        convs
            .append_classic_message(
                &conv_id,
                &json!({
                    "id": "r-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "turnId": "turn-1",
                    "content": "Choose env",
                    "sources": ["sess-live"],
                    "question": { "options": ["Prod", "Dev"], "prompt": "Which?" },
                    "cards": [{ "cardId": "card:question:reply:r-1", "resolvedState": "open" }],
                    "createdAt": "2026-11-22T01:03:00.000Z",
                }),
            )
            .unwrap();

        let directory = BotDirectory::new(data_home);

        // Missing/archived workspace check
        assert_eq!(
            directory.read_conversation("missing-ws", &ReadConversationOptions::default()),
            json!({ "ok": false, "code": "NOT_FOUND" })
        );

        // processFor invalid input checks
        assert_eq!(
            directory.read_conversation(
                ws,
                &ReadConversationOptions {
                    process_for: Some("   ".to_owned()),
                    ..Default::default()
                }
            ),
            json!({ "ok": false, "code": "INVALID_INPUT" })
        );
        assert_eq!(
            directory.read_conversation(
                ws,
                &ReadConversationOptions {
                    process_for: Some("r-1".to_owned()),
                    presentation_only: true,
                    ..Default::default()
                }
            ),
            json!({ "ok": false, "code": "INVALID_INPUT" })
        );

        // Default view (without coordination-v2 dir -> empty coordination snapshot ok)
        let def = directory.read_conversation(ws, &ReadConversationOptions::default());
        assert_eq!(def["ok"], true);
        assert_eq!(def["activeReplyQuestionId"], "r-1");
        assert!(def["familiarizeOffer"].is_object());
        let msgs = def["messages"].as_array().unwrap();
        // u-1, turn-1 (kept in default view for client disposition), r-1, plus standalone readme_offer card
        assert_eq!(msgs.len(), 4);
        let r1 = msgs.iter().find(|m| m["id"] == "r-1").unwrap();
        assert_eq!(r1["meta"]["sessionStates"], json!([]));
        assert_eq!(r1["cards"][0]["cardId"], "card:question:reply:r-1");
        let sys_card = msgs.last().unwrap();
        assert_eq!(sys_card["kind"], "system_card");
        assert_eq!(
            sys_card["cards"][0]["cardId"],
            format!("card:readme_offer:{ws}")
        );

        // view: "cards"
        let cards_res = directory.read_conversation(
            ws,
            &ReadConversationOptions {
                view: Some("cards".to_owned()),
                ..Default::default()
            },
        );
        assert_eq!(cards_res["ok"], true);
        assert_eq!(cards_res["cards"].as_array().unwrap().len(), 2);

        // processFor trace drilldown
        let proc_res = directory.read_conversation(
            ws,
            &ReadConversationOptions {
                process_for: Some("r-1".to_owned()),
                ..Default::default()
            },
        );
        assert_eq!(proc_res["ok"], true);
        assert_eq!(proc_res["processMessageId"], "r-1");
        let proc_ids: Vec<&str> = proc_res["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["id"].as_str())
            .collect();
        assert_eq!(proc_ids, vec!["turn-1", "r-1"]);

        // Simulate missing SQLite coordination read-model pointer while coordination-v2 exists
        fs::create_dir_all(
            data_home
                .join("project-runtime")
                .join(ws)
                .join("coordination-v2"),
        )
        .unwrap();
        let def_err = directory.read_conversation(ws, &ReadConversationOptions::default());
        assert_eq!(
            def_err,
            json!({ "ok": false, "code": "coordination_index_missing" })
        );
        let cards_err = directory.read_conversation(
            ws,
            &ReadConversationOptions {
                view: Some("cards".to_owned()),
                ..Default::default()
            },
        );
        assert_eq!(
            cards_err,
            json!({ "ok": false, "cards": [], "code": "coordination_index_missing" })
        );

        // view: "interactions" MUST stay isolated from coordination SQLite failure!
        let inter_res = directory.read_conversation(
            ws,
            &ReadConversationOptions {
                view: Some("interactions".to_owned()),
                ..Default::default()
            },
        );
        assert_eq!(inter_res["ok"], true);
        assert!(
            inter_res["sourceVersion"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert!(inter_res["familiarizeOffer"].is_object());
        let inter_ids: Vec<&str> = inter_res["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["id"].as_str())
            .collect();
        assert_eq!(inter_ids, vec!["u-1", "r-1"]);
    }

    #[test]
    fn project_bot_list_message_strips_dsml_and_xml_tool_markup_from_preview() {
        let pure_dsml = json!({
            "id": "r-dsml",
            "role": "assistant",
            "kind": "agent_reply",
            "content": "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"read_file\">\n<｜DSML｜ parameter name=\"path\" string=\"true\">foo.css</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>",
            "createdAt": "2026-11-22T14:12:00.000Z"
        });
        assert_eq!(project_bot_list_message(&pure_dsml).text, "");

        let mixed = json!({
            "id": "r-mixed",
            "role": "assistant",
            "kind": "agent_reply",
            "content": "已经查完前半段。\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"read_file\"></｜DSML｜ invoke>\n</｜DSML｜ calls>",
            "createdAt": "2026-11-22T14:12:05.000Z"
        });
        assert_eq!(project_bot_list_message(&mixed).text, "已经查完前半段。");

        let user_msg = json!({
            "id": "u-raw",
            "role": "user",
            "kind": "user_input",
            "content": "为什么会出现 <｜DSML｜ calls> 这种乱码？",
            "createdAt": "2026-11-22T14:12:10.000Z"
        });
        assert!(
            project_bot_list_message(&user_msg)
                .text
                .contains("<｜DSML｜ calls>"),
            "user questions quoting DSML stay visible"
        );
    }

    #[test]
    fn project_bot_list_item_separates_active_history_and_hides_obligation_indexed() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        let (profile, _) = profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Peer-Agent",
                managed: false,
                agent_conversation_id: "conv-1",
                avatar_salt: "",
            })
            .unwrap();
        let make_sess =
            |id: &str, status: &str, title: &str, updated: &str, fu: FollowUpProjection| {
                BotListSession {
                    session_id: id.into(),
                    title: title.into(),
                    status: status.into(),
                    updated_at: Some(updated.into()),
                    result_confirmation_required: None,
                    completion_review_required: false,
                    conversation_id: None,
                    queue_reason: None,
                    follow_up: Some(fu),
                    phase_label: None,
                    anchor_message_id: None,
                    plan_id: Some(format!("p-{id}")),
                }
            };
        let sessions = vec![
            make_sess(
                "s-run",
                "running",
                "Running Task",
                "2026-11-23T09:10:00.000Z",
                FollowUpProjection {
                    in_current_list: true,
                    owner: "bot".into(),
                    reason: "live_execution".into(),
                },
            ),
            make_sess(
                "s-obl",
                "running",
                "Hidden Obligation",
                "2026-11-23T09:20:00.000Z",
                FollowUpProjection {
                    in_current_list: false,
                    owner: "none".into(),
                    reason: "obligation_indexed".into(),
                },
            ),
            make_sess(
                "s-vf",
                "result_ready",
                "Verification Failed",
                "2026-11-23T09:05:00.000Z",
                FollowUpProjection {
                    in_current_list: true,
                    owner: "bot".into(),
                    reason: "verification_failed".into(),
                },
            ),
            make_sess(
                "s-wait",
                "waiting_user",
                "Needs Approval",
                "2026-11-23T09:00:00.000Z",
                FollowUpProjection {
                    in_current_list: true,
                    owner: "user".into(),
                    reason: "human_request".into(),
                },
            ),
            make_sess(
                "s-done",
                "accepted",
                "Settled Task",
                "2026-11-23T08:30:00.000Z",
                FollowUpProjection {
                    in_current_list: false,
                    owner: "none".into(),
                    reason: "settled".into(),
                },
            ),
        ];

        let item = project_bot_list_item(profile, None, &sessions, &[], None);
        assert_eq!(item.active_session_total, 3);
        assert_eq!(item.history_session_total, 1);
        let ids: Vec<&str> = item
            .active_sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        assert_eq!(ids, vec!["s-wait", "s-vf", "s-run"]);
    }

    #[test]
    fn queued_reply_answer_clears_needs_you_and_attention_before_consume() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        let convs = ConversationStore::new(dir.path());
        let at = "2026-11-27T03:01:34.048Z";
        let conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "peer-dev",
                    workspace_id: "ws-queued",
                    workspace_path: Some("/tmp/peer-dev"),
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
                workspace_id: "ws-queued",
                display_name: "peer-dev",
                managed: false,
                agent_conversation_id: conv_id,
                avatar_salt: "",
            })
            .unwrap();
        convs
            .append_message_idempotent(
                conv_id,
                &json!({
                    "id": "reply-q-open",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Choose option A or B?",
                    "createdAt": at,
                    "question": { "options": ["Option A", "Option B"] }
                }),
                at,
                None,
            )
            .unwrap();

        let directory = BotDirectory::new(dir.path());
        assert_eq!(directory.list(&HashMap::new())[0].state.needs_you, 1);
        assert_eq!(
            directory
                .list_attention(Some("ws-queued"), &HashMap::new())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            directory.question_state("ws-queued", "reply-q-open"),
            Some(QuestionState::Open)
        );

        // Submit answer to InputQueue WITHOUT calling consume() (simulating a long wake turn holding lock).
        let queue = InputQueue::new(dir.path());
        queue
            .submit_input(&crate::SubmitInputRequest {
                workspace_id: "ws-queued",
                input_id: "in-queued-ans-1",
                surface: "desktop",
                text: "Option A",
                anchor_refs: vec![],
                quote_refs: vec![],
                task_refs: vec![],
                attachment_refs: vec![],
                attachments: vec![],
                answer_to: Some("card:question:reply:reply-q-open".into()),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            })
            .unwrap();

        let listed = directory.list(&HashMap::new());
        assert_eq!(listed[0].state.needs_you, 0);
        // Unread/preview still come from committed messages only.
        assert_eq!(listed[0].state.unread, 1);
        assert!(
            directory
                .list_attention(Some("ws-queued"), &HashMap::new())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            directory.question_state("ws-queued", "reply-q-open"),
            Some(QuestionState::Answered)
        );
    }

    #[test]
    fn queued_freeform_input_respects_timestamps_and_skips_already_consumed_inputs() {
        let now_ms = parse_iso_ms("2026-11-27T03:10:00.000Z").unwrap();
        let messages = vec![
            json!({
                "id": "reply-q1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Earlier question",
                "createdAt": "2026-11-27T03:01:00.000Z",
                "question": { "options": ["A"] }
            }),
            json!({
                "id": "input-already-in-conv",
                "inputId": "already-in-conv",
                "role": "user",
                "kind": "user_input",
                "content": "Already consumed",
                "createdAt": "2026-11-27T03:02:00.000Z"
            }),
            json!({
                "id": "reply-q2",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Newer question",
                "createdAt": "2026-11-27T03:05:00.000Z",
                "question": { "options": ["B"] }
            }),
        ];

        // 1. An already-consumed input (crash before cursor advance) must NOT supersede reply-q2.
        // 2. An older freeform queued input (03:04) must NOT supersede reply-q2 (03:05).
        let stale_queued = vec![
            QueuedInputMeta {
                input_id: "already-in-conv".into(),
                created_at: "2026-11-27T03:02:00.000Z".into(),
                answer_to: None,
            },
            QueuedInputMeta {
                input_id: "older-freeform".into(),
                created_at: "2026-11-27T03:04:00.000Z".into(),
                answer_to: None,
            },
        ];
        let states_keep = project_reply_questions_with_queued(&messages, &stale_queued, now_ms);
        assert_eq!(states_keep["reply-q1"].state, QuestionState::Superseded);
        assert_eq!(states_keep["reply-q2"].state, QuestionState::Open);

        // 3. A newer freeform queued input (03:06 >= 03:05) supersedes reply-q2 immediately.
        let newer_queued = vec![QueuedInputMeta {
            input_id: "newer-freeform".into(),
            created_at: "2026-11-27T03:06:00.000Z".into(),
            answer_to: None,
        }];
        let states_superseded =
            project_reply_questions_with_queued(&messages, &newer_queued, now_ms);
        assert_eq!(
            states_superseded["reply-q2"].state,
            QuestionState::Superseded
        );
    }
}
