//! Canonical Project Agent card projection and persisted resolution folding.
//!
//! Matches `packages/runtime-node/src/project-agent/card-projection.mjs` and
//! `packages/runtime-node/src/project-agent/project-facts.mjs` (`latestTaskQuestion`,
//! `questionCards`). Host facts own authority-bearing cards (`approval`,
//! `plan_approval`, `confirm_result`, `completion_review`); `cards.jsonl` records
//! only non-authoritative UI dismissals.

use crate::{BotListSession, ProjectError, is_valid_workspace_id, utf16_slice};
use peer_store::ConversationStore;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

const ID_MAX: usize = 200;
const CARD_ID_MAX: usize = 500;
const TEXT_MAX: usize = 240;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardResolution {
    pub card_id: String,
    pub resolved_state: String,
    #[serde(default)]
    pub at: String,
    #[serde(default)]
    pub resolution: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskQuestionDraft {
    pub session_id: String,
    pub question_id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub answered: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfirmCardInput {
    pub session_id: String,
    pub summary: String,
    pub accepted: bool,
    pub needs_confirm: Option<bool>,
}

struct DraftCard {
    card_id: String,
    kind: &'static str,
    content: String,
    fact_resolved: bool,
    fact_state: String,
    has_failure_status: bool,
    actions: Vec<Value>,
    refs: Map<String, Value>,
}

fn bounded_id(value: Option<&str>, max: usize) -> String {
    let Some(raw) = value else {
        return String::new();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.encode_utf16().count() > max || trimmed.contains(['\r', '\n'])
    {
        return String::new();
    }
    trimmed.to_owned()
}

fn clip_text(value: Option<&str>, fallback: &str) -> String {
    let Some(raw) = value else {
        return fallback.to_owned();
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback.to_owned();
    }
    utf16_slice(trimmed, TEXT_MAX).to_owned()
}

fn card_id_of(kind: &str, suffix: &str) -> String {
    let card_id = format!("card:{kind}:{suffix}");
    if card_id.encode_utf16().count() <= CARD_ID_MAX {
        card_id
    } else {
        String::new()
    }
}

fn is_closed_approval(state: &str) -> bool {
    matches!(state, "approved" | "denied" | "expired" | "cancelled")
}

fn is_plan_approval(approval: &Value) -> bool {
    approval["kind"].as_str() == Some("plan_approval")
        || approval["capabilityId"].as_str() == Some("goal.plan")
}

fn answer_actions(card_id: &str, options: &[String]) -> Vec<Value> {
    let mut choices = Vec::new();
    let mut seen = HashSet::new();
    for option in options {
        let text = bounded_id(Some(option.as_str()), ID_MAX);
        if text.is_empty() || !seen.insert(text.clone()) {
            continue;
        }
        choices.push(text);
    }
    if choices.is_empty() {
        vec![json!({
            "id": "answer",
            "channel": "project-agent:submit-input",
            "payload": { "answerTo": card_id },
        })]
    } else {
        choices
            .into_iter()
            .map(|text| {
                json!({
                    "id": "answer",
                    "channel": "project-agent:submit-input",
                    "payload": { "answerTo": card_id, "text": text },
                })
            })
            .collect()
    }
}

fn insert_bounded_ref(
    map: &mut Map<String, Value>,
    key: &str,
    value: Option<&str>,
    already_bounded: Option<&str>,
) {
    if let Some(v) = already_bounded {
        if !v.is_empty() {
            map.insert(key.to_owned(), json!(v));
        }
        return;
    }
    let cleaned = bounded_id(value, ID_MAX);
    if !cleaned.is_empty() {
        map.insert(key.to_owned(), json!(cleaned));
    }
}

fn approval_refs(approval: &Value, approval_id: &str) -> Map<String, Value> {
    let mut map = Map::new();
    insert_bounded_ref(&mut map, "approvalId", None, Some(approval_id));
    insert_bounded_ref(&mut map, "sessionId", approval["sessionId"].as_str(), None);
    insert_bounded_ref(
        &mut map,
        "capabilityId",
        approval["capabilityId"].as_str(),
        None,
    );
    insert_bounded_ref(&mut map, "riskLevel", approval["riskLevel"].as_str(), None);
    insert_bounded_ref(&mut map, "taskName", approval["taskName"].as_str(), None);
    insert_bounded_ref(
        &mut map,
        "conversationId",
        approval["conversationId"].as_str(),
        None,
    );
    insert_bounded_ref(&mut map, "streamId", approval["streamId"].as_str(), None);
    insert_bounded_ref(
        &mut map,
        "deadlineAt",
        approval["deadlineAt"].as_str(),
        None,
    );
    insert_bounded_ref(
        &mut map,
        "decisionReason",
        approval["decisionReason"].as_str(),
        None,
    );
    map
}

fn approval_content(approval: &Value) -> String {
    if approval["capabilityId"].as_str() == Some("local.image.read")
        && let Some(img_path) = approval["imageReadScope"]["path"]
            .as_str()
            .filter(|s| !s.is_empty())
    {
        return clip_text(Some(img_path), "图片");
    }
    let summary = clip_text(approval["summary"].as_str(), "需要你批准");
    let extra: Vec<String> = ["capabilityId", "riskLevel", "taskName"]
        .iter()
        .filter_map(|k| {
            let v = bounded_id(approval[*k].as_str(), ID_MAX);
            (!v.is_empty()).then_some(v)
        })
        .collect();
    if extra.is_empty() {
        summary
    } else {
        let joined = format!("{summary} · {}", extra.join(" · "));
        clip_text(Some(&joined), &summary)
    }
}

fn approval_actions(approval_id: &str, state: &str, capability_id: &str) -> Vec<Value> {
    if state == "stale" && capability_id != "local.image.read" {
        return vec![json!({
            "id": "continue",
            "channel": "project-agent:decide-approval",
            "payload": {
                "approvalId": approval_id,
                "decision": "approve",
                "duration": "once",
            },
        })];
    }
    let mut allow_task_payload = json!({
        "approvalId": approval_id,
        "decision": "approve",
        "duration": "task",
    });
    if capability_id == "local.image.read" {
        allow_task_payload["capabilityId"] = json!(capability_id);
    }
    let mut actions = vec![
        json!({
            "id": "allow",
            "channel": "project-agent:decide-approval",
            "payload": {
                "approvalId": approval_id,
                "decision": "approve",
                "duration": "once",
            },
        }),
        json!({
            "id": "allow_task",
            "channel": "project-agent:decide-approval",
            "payload": allow_task_payload,
        }),
        json!({
            "id": "reject",
            "channel": "project-agent:decide-approval",
            "payload": {
                "approvalId": approval_id,
                "decision": "reject",
                "duration": "denied",
            },
        }),
    ];
    if capability_id == "local.image.read" {
        actions.push(json!({
            "id": "cancel_read",
            "channel": "project-agent:decide-approval",
            "payload": {
                "approvalId": approval_id,
                "decision": "cancel",
                "duration": "denied",
            },
        }));
    }
    actions
}

fn build_approval_cards(approvals: &[&Value], out: &mut Vec<DraftCard>) {
    for &approval in approvals {
        if is_plan_approval(approval) || approval["kind"].as_str() == Some("image_read_grant") {
            continue;
        }
        let approval_id = bounded_id(approval["approvalId"].as_str(), ID_MAX);
        if approval_id.is_empty() {
            continue;
        }
        let state = approval["state"].as_str().unwrap_or("open");
        if state != "open" && state != "stale" && !is_closed_approval(state) {
            continue;
        }
        let closed = is_closed_approval(state);
        let card_id = card_id_of("approval", &approval_id);
        if card_id.is_empty() {
            continue;
        }
        let cap = approval["capabilityId"].as_str().unwrap_or("");
        let actions = if closed {
            Vec::new()
        } else {
            approval_actions(&approval_id, state, cap)
        };
        out.push(DraftCard {
            card_id,
            kind: "approval",
            content: approval_content(approval),
            fact_resolved: closed,
            fact_state: if closed {
                state.to_owned()
            } else {
                String::new()
            },
            has_failure_status: false,
            actions,
            refs: approval_refs(approval, &approval_id),
        });
    }
}

fn build_plan_approval_cards(approvals: &[&Value], out: &mut Vec<DraftCard>) {
    for &approval in approvals {
        if !is_plan_approval(approval) {
            continue;
        }
        let approval_id = bounded_id(approval["approvalId"].as_str(), ID_MAX);
        let session_id = bounded_id(approval["sessionId"].as_str(), ID_MAX);
        if approval_id.is_empty() && session_id.is_empty() {
            continue;
        }
        let key = if !approval_id.is_empty() {
            approval_id
        } else {
            session_id
        };
        let state = approval["state"].as_str().unwrap_or("open");
        if state != "open" && state != "stale" && !is_closed_approval(state) {
            continue;
        }
        let closed = is_closed_approval(state);
        let card_id = card_id_of("plan_approval", &key);
        if card_id.is_empty() {
            continue;
        }
        let actions = if closed {
            Vec::new()
        } else {
            vec![
                json!({
                    "id": "approve",
                    "channel": "project-agent:decide-approval",
                    "payload": { "approvalId": key, "decision": "approve" },
                }),
                json!({
                    "id": "reject",
                    "channel": "project-agent:decide-approval",
                    "payload": { "approvalId": key, "decision": "reject", "duration": "denied" },
                }),
            ]
        };
        out.push(DraftCard {
            card_id,
            kind: "plan_approval",
            content: clip_text(approval["summary"].as_str(), "计划待批准"),
            fact_resolved: closed,
            fact_state: if closed {
                state.to_owned()
            } else {
                String::new()
            },
            has_failure_status: false,
            actions,
            refs: approval_refs(approval, &key),
        });
    }
}

fn build_task_question_cards(task_questions: &[TaskQuestionDraft], out: &mut Vec<DraftCard>) {
    for question in task_questions {
        let session_id = bounded_id(Some(question.session_id.as_str()), ID_MAX);
        let question_id = bounded_id(Some(question.question_id.as_str()), ID_MAX);
        if session_id.is_empty() || question_id.is_empty() {
            continue;
        }
        let card_id = card_id_of("question", &format!("{session_id}:{question_id}"));
        if card_id.is_empty() {
            continue;
        }
        let actions = answer_actions(&card_id, &question.options);
        let mut refs = Map::new();
        refs.insert("sessionId".into(), json!(session_id));
        refs.insert("questionId".into(), json!(question_id));
        out.push(DraftCard {
            card_id,
            kind: "question",
            content: clip_text(Some(question.prompt.as_str()), "需要你回答"),
            fact_resolved: question.answered,
            fact_state: if question.answered {
                "answered".into()
            } else {
                String::new()
            },
            has_failure_status: false,
            actions,
            refs,
        });
    }
}

fn build_reply_question_cards(replies: &[&Value], out: &mut Vec<DraftCard>) {
    for &reply in replies {
        let Some(q) = reply.get("question").filter(|v| v.is_object()) else {
            continue;
        };
        let reply_message_id = bounded_id(
            reply["id"].as_str().or_else(|| reply["messageId"].as_str()),
            ID_MAX,
        );
        if reply_message_id.is_empty() {
            continue;
        }
        let card_id = card_id_of("question", &format!("reply:{reply_message_id}"));
        if card_id.is_empty() {
            continue;
        }
        let state_str = q["state"].as_str().unwrap_or("");
        let answered = q["answered"].as_bool() == Some(true) || state_str == "answered";
        let fact_state = if answered {
            if state_str.is_empty() {
                "answered".to_owned()
            } else {
                state_str.to_owned()
            }
        } else {
            String::new()
        };
        let options: Vec<String> = q["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let actions = answer_actions(&card_id, &options);
        let mut refs = Map::new();
        refs.insert("replyMessageId".into(), json!(reply_message_id));
        out.push(DraftCard {
            card_id,
            kind: "question",
            content: clip_text(q["prompt"].as_str(), "需要你回答"),
            fact_resolved: answered,
            fact_state,
            has_failure_status: false,
            actions,
            refs,
        });
    }
}

fn build_confirm_cards(confirmations: &[ConfirmCardInput], out: &mut Vec<DraftCard>) {
    for confirmation in confirmations {
        if confirmation.needs_confirm == Some(false) {
            continue;
        }
        let session_id = bounded_id(Some(confirmation.session_id.as_str()), ID_MAX);
        if session_id.is_empty() {
            continue;
        }
        let card_id = card_id_of("confirm_result", &session_id);
        if card_id.is_empty() {
            continue;
        }
        let actions = if confirmation.accepted {
            Vec::new()
        } else {
            vec![json!({
                "id": "confirm",
                "channel": "project-agent:confirm-result",
                "payload": {
                    "sessionId": session_id,
                    "cardId": card_id,
                    "acceptedBy": "user",
                },
            })]
        };
        let mut refs = Map::new();
        refs.insert("sessionId".into(), json!(session_id));
        out.push(DraftCard {
            card_id,
            kind: "confirm_result",
            content: clip_text(Some(confirmation.summary.as_str()), "需要你确认结果"),
            fact_resolved: confirmation.accepted,
            fact_state: if confirmation.accepted {
                "accepted".into()
            } else {
                String::new()
            },
            has_failure_status: false,
            actions,
            refs,
        });
    }
}

fn apply_resolution(card: DraftCard, stored: Option<&CardResolution>) -> Value {
    let fact_owned = matches!(
        card.kind,
        "approval" | "plan_approval" | "confirm_result" | "completion_review"
    );
    let unsupported_retry = stored.is_some_and(|s| s.resolution == "retried")
        && !card.fact_resolved
        && matches!(card.kind, "agent_unavailable" | "agent_stopped");
    let store_resolved = !fact_owned
        && stored.is_some_and(|s| s.resolved_state == "resolved")
        && !unsupported_retry
        && !card.has_failure_status;
    let resolved = card.fact_resolved || store_resolved;

    let mut obj = Map::new();
    obj.insert("cardId".into(), json!(card.card_id));
    obj.insert("kind".into(), json!(card.kind));
    obj.insert(
        "resolvedState".into(),
        json!(if resolved { "resolved" } else { "open" }),
    );
    if card.fact_resolved {
        obj.insert(
            "resolution".into(),
            json!({ "source": "fact", "state": card.fact_state }),
        );
    } else if store_resolved && let Some(s) = stored {
        let mut res = Map::new();
        res.insert("source".into(), json!("store"));
        let state = if s.resolution.is_empty() {
            "resolved"
        } else {
            s.resolution.as_str()
        };
        res.insert("state".into(), json!(state));
        if !s.at.is_empty() {
            res.insert("at".into(), json!(s.at));
        }
        obj.insert("resolution".into(), Value::Object(res));
    }
    obj.insert("content".into(), json!(card.content));
    obj.insert(
        "actions".into(),
        if resolved {
            json!([])
        } else {
            Value::Array(card.actions)
        },
    );
    obj.insert("refs".into(), Value::Object(card.refs));
    Value::Object(obj)
}

/// Read persisted non-authoritative card resolutions from `<data_home>/project-runtime/<ws>/cards.jsonl`.
pub fn read_card_resolutions(
    data_home: &Path,
    workspace_id: &str,
) -> Result<Vec<CardResolution>, ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("INVALID_WORKSPACE"));
    }
    let file = data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("cards.jsonl");
    let Ok(raw) = fs::read_to_string(file) else {
        return Ok(Vec::new());
    };
    let mut records = Vec::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(obj) = val.as_object() else {
            continue;
        };
        let card_id = bounded_id(obj.get("cardId").and_then(Value::as_str), CARD_ID_MAX);
        if card_id.is_empty() {
            continue;
        }
        let Some(resolved_state) = obj
            .get("resolvedState")
            .and_then(Value::as_str)
            .filter(|s| matches!(*s, "open" | "resolved"))
        else {
            continue;
        };
        let at = obj
            .get("at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let resolution = obj
            .get("resolution")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        records.push(CardResolution {
            card_id,
            resolved_state: resolved_state.to_owned(),
            at,
            resolution,
        });
    }
    Ok(records)
}

/// Project canonical cards from host facts, applying folded `cards.jsonl` resolutions and
/// sorting deterministically by `cardId` (matching `card-projection.mjs#projectCards`).
pub fn project_cards(
    workspace_id: &str,
    replies: &[&Value],
    approvals: &[&Value],
    confirmations: &[ConfirmCardInput],
    task_questions: &[TaskQuestionDraft],
    resolutions: &[CardResolution],
) -> Result<Vec<Value>, ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("INVALID_WORKSPACE"));
    }
    let mut stored_by_id: HashMap<&str, &CardResolution> = HashMap::new();
    for record in resolutions {
        if !record.card_id.is_empty()
            && matches!(record.resolved_state.as_str(), "open" | "resolved")
        {
            stored_by_id.insert(record.card_id.as_str(), record);
        }
    }

    let mut built = Vec::new();
    build_approval_cards(approvals, &mut built);
    build_plan_approval_cards(approvals, &mut built);
    build_task_question_cards(task_questions, &mut built);
    build_reply_question_cards(replies, &mut built);
    build_confirm_cards(confirmations, &mut built);

    let mut seen_ids = HashSet::new();
    let mut unique = Vec::new();
    for card in built {
        if card.card_id.is_empty() || !seen_ids.insert(card.card_id.clone()) {
            continue;
        }
        let stored = stored_by_id.get(card.card_id.as_str()).copied();
        unique.push(apply_resolution(card, stored));
    }
    unique.sort_by(|a, b| {
        let aid = a["cardId"].as_str().unwrap_or("");
        let bid = b["cardId"].as_str().unwrap_or("");
        aid.encode_utf16().cmp(bid.encode_utf16())
    });
    Ok(unique)
}

/// Find the latest `request_user_input` tool prompt inside a child session conversation,
/// matching `packages/runtime-node/src/project-agent/project-facts.mjs#latestTaskQuestion`.
pub fn latest_task_question(messages: &[Value]) -> Option<(String, String, Vec<String>)> {
    for msg in messages.iter().rev() {
        let Some(segments) = msg["segments"].as_array() else {
            continue;
        };
        for seg in segments.iter().rev() {
            if seg["tool"].as_str() != Some("request_user_input") || !seg["args"].is_object() {
                continue;
            }
            let args = &seg["args"];
            let question_id = seg["toolCallId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| msg["id"].as_str().filter(|s| !s.is_empty()))?
                .to_owned();
            let prompt = args["question"]
                .as_str()
                .or_else(|| args["prompt"].as_str())
                .unwrap_or("")
                .to_owned();
            let options = args["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|opt| opt.as_str().or_else(|| opt["label"].as_str()))
                .map(str::to_owned)
                .collect();
            return Some((question_id, prompt, options));
        }
    }
    None
}

/// Project pending `waiting_user` task question cards matching `project-facts.mjs#questionCards`.
pub fn project_waiting_user_question_cards(
    data_home: &Path,
    workspace_id: &str,
    parent_messages: &[Value],
    waiting_sessions: &[&BotListSession],
    resolutions: &[CardResolution],
) -> Vec<Value> {
    if waiting_sessions.is_empty() {
        return Vec::new();
    }
    let conversations = ConversationStore::new(data_home);
    let mut drafts = Vec::new();
    for session in waiting_sessions {
        if session.status != "waiting_user" {
            continue;
        }
        if matches!(
            session.queue_reason.as_deref(),
            Some("dependency_failed" | "dependency_missing")
        ) {
            let answer_to = format!("card:question:{}:dependency", session.session_id);
            let answered = parent_messages
                .iter()
                .any(|m| m["answerTo"].as_str() == Some(answer_to.as_str()));
            drafts.push(TaskQuestionDraft {
                session_id: session.session_id.clone(),
                question_id: "dependency".into(),
                prompt: format!(
                    "「{}」的前置任务未成功签收。要取消还是重新安排？",
                    session.title
                ),
                options: vec!["取消这个任务".into(), "重新安排任务".into()],
                answered,
            });
            continue;
        }
        let Some(conv_id) = session.conversation_id.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        let child_msgs = if let Ok(Some(page)) =
            conversations.read_conversation_window(conv_id, None, None, true)
        {
            page["window"].as_array().cloned().unwrap_or_default()
        } else {
            conversations
                .read_committed(conv_id, None, 8 * 1024 * 1024)
                .map(|snap| snap.history.messages)
                .unwrap_or_default()
        };
        let Some((question_id, prompt, options)) = latest_task_question(&child_msgs) else {
            continue;
        };
        let answer_to = format!("card:question:{}:{question_id}", session.session_id);
        let answered = parent_messages
            .iter()
            .any(|m| m["answerTo"].as_str() == Some(answer_to.as_str()));
        drafts.push(TaskQuestionDraft {
            session_id: session.session_id.clone(),
            question_id,
            prompt,
            options,
            answered,
        });
    }
    if drafts.is_empty() {
        return Vec::new();
    }
    project_cards(workspace_id, &[], &[], &[], &drafts, resolutions).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn projects_approval_plan_image_confirm_and_task_question_cards() {
        let dir = tempdir().unwrap();
        let file_approval = json!({
            "approvalId": "ap-write",
            "sessionId": "sess-1",
            "capabilityId": "local.file.write",
            "summary": "Write hello.txt",
            "riskLevel": "medium",
            "taskName": "Edit",
            "state": "open",
        });
        let stale_approval = json!({
            "approvalId": "ap-stale",
            "sessionId": "sess-2",
            "capabilityId": "local.shell.exec",
            "summary": "Run cargo test",
            "state": "stale",
        });
        let img_approval = json!({
            "approvalId": "ap-img",
            "sessionId": "sess-1",
            "capabilityId": "local.image.read",
            "imageReadScope": { "path": "/tmp/shot.png" },
            "state": "open",
        });
        let img_grant = json!({
            "approvalId": "grant-img",
            "kind": "image_read_grant",
            "capabilityId": "local.image.read",
            "state": "open",
        });
        let plan_approval = json!({
            "approvalId": "plan:p-1",
            "sessionId": "sess-3",
            "capabilityId": "goal.plan",
            "summary": "Approve refactor plan",
            "state": "open",
        });
        let reply = json!({
            "id": "reply-1",
            "role": "assistant",
            "kind": "agent_reply",
            "question": { "prompt": "Proceed with deploy?", "options": ["Yes", "No"] },
        });
        let confirms = vec![ConfirmCardInput {
            session_id: "sess-4".into(),
            summary: "Review patch".into(),
            accepted: false,
            needs_confirm: None,
        }];
        let tqs = vec![TaskQuestionDraft {
            session_id: "sess-5".into(),
            question_id: "q-fmt".into(),
            prompt: "Choose format".into(),
            options: vec!["CSV".into(), "JSON".into()],
            answered: false,
        }];

        // Write cards.jsonl attempting to dismiss BOTH a reply question (valid) AND an
        // authority-owned approval (must be ignored by `factOwned`).
        let rt_dir = dir.path().join("project-runtime/ws-cards");
        fs::create_dir_all(&rt_dir).unwrap();
        fs::write(
            rt_dir.join("cards.jsonl"),
            concat!(
                "{\"cardId\":\"card:approval:ap-write\",\"resolvedState\":\"resolved\",\"at\":\"2026-11-22T00:00:00.000Z\"}\n",
                "not json\n",
                "{\"cardId\":\"card:question:reply:reply-1\",\"resolvedState\":\"resolved\",\"at\":\"2026-11-22T00:01:00.000Z\",\"resolution\":\"dismissed\"}\n",
            ),
        )
        .unwrap();
        let resolutions = read_card_resolutions(dir.path(), "ws-cards").unwrap();
        assert_eq!(resolutions.len(), 2);

        let cards = project_cards(
            "ws-cards",
            &[&reply],
            &[
                &file_approval,
                &stale_approval,
                &img_approval,
                &img_grant,
                &plan_approval,
            ],
            &confirms,
            &tqs,
            &resolutions,
        )
        .unwrap();

        // image_read_grant excluded -> 7 cards sorted by cardId
        assert_eq!(cards.len(), 7);
        let by_id: HashMap<&str, &Value> = cards
            .iter()
            .map(|c| (c["cardId"].as_str().unwrap(), c))
            .collect();
        assert!(!by_id.contains_key("card:approval:grant-img"));

        // Approval ignores cards.jsonl resolved record and builds standard 3 actions.
        let cw = by_id["card:approval:ap-write"];
        assert_eq!(cw["resolvedState"], "open");
        assert_eq!(
            cw["content"],
            "Write hello.txt · local.file.write · medium · Edit"
        );
        assert_eq!(cw["actions"].as_array().unwrap().len(), 3);

        // Stale non-image approval produces single `continue` action.
        let cs = by_id["card:approval:ap-stale"];
        assert_eq!(cs["actions"].as_array().unwrap().len(), 1);
        assert_eq!(cs["actions"][0]["id"], "continue");

        // local.image.read uses imageReadScope.path & 4 actions including cancel_read.
        let ci = by_id["card:approval:ap-img"];
        assert_eq!(ci["content"], "/tmp/shot.png");
        let ci_acts = ci["actions"].as_array().unwrap();
        assert_eq!(ci_acts.len(), 4);
        assert_eq!(ci_acts[1]["payload"]["capabilityId"], "local.image.read");
        assert_eq!(ci_acts[3]["id"], "cancel_read");

        // plan_approval produces approve + reject.
        let cp = by_id["card:plan_approval:plan:p-1"];
        assert_eq!(cp["actions"].as_array().unwrap().len(), 2);
        assert_eq!(cp["actions"][0]["id"], "approve");

        // Reply question honors cards.jsonl dismissal.
        let cr = by_id["card:question:reply:reply-1"];
        assert_eq!(cr["resolvedState"], "resolved");
        assert_eq!(cr["resolution"]["source"], "store");
        assert_eq!(cr["resolution"]["state"], "dismissed");
        assert_eq!(cr["actions"].as_array().unwrap().len(), 0);

        // Confirm result produces confirm action.
        let cc = by_id["card:confirm_result:sess-4"];
        assert_eq!(cc["actions"][0]["channel"], "project-agent:confirm-result");

        // Task question card.
        let ct = by_id["card:question:sess-5:q-fmt"];
        assert_eq!(ct["actions"][0]["payload"]["text"], "CSV");
        assert_eq!(ct["actions"][1]["payload"]["text"], "JSON");
    }

    #[test]
    fn latest_task_question_extracts_most_recent_request_user_input_segment() {
        let msgs = vec![
            json!({
                "id": "m1",
                "segments": [
                    { "tool": "request_user_input", "toolCallId": "q-old", "args": { "prompt": "Old?", "options": ["A"] } },
                    { "tool": "bash", "args": {} }
                ]
            }),
            json!({
                "id": "m2",
                "segments": [
                    { "tool": "request_user_input", "args": { "question": "New?", "options": [{ "label": "X" }, "Y"] } }
                ]
            }),
        ];
        let (qid, prompt, options) = latest_task_question(&msgs).unwrap();
        assert_eq!(qid, "m2");
        assert_eq!(prompt, "New?");
        assert_eq!(options, vec!["X", "Y"]);
    }
}
