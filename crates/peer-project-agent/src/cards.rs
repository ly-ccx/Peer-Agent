//! Canonical Project Agent card projection and persisted resolution folding.
//!
//! Matches `packages/runtime-node/src/project-agent/card-projection.mjs` and
//! `packages/runtime-node/src/project-agent/project-facts.mjs` (`latestTaskQuestion`,
//! `questionCards`). Host facts own authority-bearing cards (`approval`,
//! `plan_approval`, `confirm_result`, `completion_review`); `cards.jsonl` records
//! only non-authoritative UI dismissals.

use crate::{
    BotListSession, BotProfileStore, InputQueue, MemoryFilter, MemoryStore, ObjectiveActions,
    ObjectiveStore, ProjectError, QueuedInputMeta,
    acceptance::{handoff_question_id, is_handoff_conflict},
    directory::{
        QuestionState, is_answer_recorded, project_reply_questions,
        project_reply_questions_with_queued,
    },
    is_valid_workspace_id, now_iso,
    obligation::read_coordination_snapshot_readonly,
    parse_iso_ms,
    session_projection::{
        build_session_report, list_sessions_projected, project_completion_review_for_plan,
    },
    supervisor::SessionSupervisor,
    utf16_slice,
};
use peer_store::{ApprovalStore, ConversationStore};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
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
    failure_status: Option<Value>,
    recovery_action: Option<Value>,
    completion_review: Option<Value>,
    recovery: Option<Value>,
    recovery_work_state: Option<Value>,
    actions: Vec<Value>,
    refs: Map<String, Value>,
}

impl DraftCard {
    fn basic(
        card_id: String,
        kind: &'static str,
        content: String,
        fact_resolved: bool,
        fact_state: String,
        actions: Vec<Value>,
        refs: Map<String, Value>,
    ) -> Self {
        Self {
            card_id,
            kind,
            content,
            fact_resolved,
            fact_state,
            has_failure_status: false,
            failure_status: None,
            recovery_action: None,
            completion_review: None,
            recovery: None,
            recovery_work_state: None,
            actions,
            refs,
        }
    }
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
        out.push(DraftCard::basic(
            card_id,
            "approval",
            approval_content(approval),
            closed,
            if closed {
                state.to_owned()
            } else {
                String::new()
            },
            actions,
            approval_refs(approval, &approval_id),
        ));
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
        out.push(DraftCard::basic(
            card_id,
            "plan_approval",
            clip_text(approval["summary"].as_str(), "计划待批准"),
            closed,
            if closed {
                state.to_owned()
            } else {
                String::new()
            },
            actions,
            approval_refs(approval, &key),
        ));
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
        out.push(DraftCard::basic(
            card_id,
            "question",
            clip_text(Some(question.prompt.as_str()), "需要你回答"),
            question.answered,
            if question.answered {
                "answered".into()
            } else {
                String::new()
            },
            actions,
            refs,
        ));
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
        out.push(DraftCard::basic(
            card_id,
            "question",
            clip_text(q["prompt"].as_str(), "需要你回答"),
            answered,
            fact_state,
            actions,
            refs,
        ));
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
        out.push(DraftCard::basic(
            card_id,
            "confirm_result",
            clip_text(Some(confirmation.summary.as_str()), "需要你确认结果"),
            confirmation.accepted,
            if confirmation.accepted {
                "accepted".into()
            } else {
                String::new()
            },
            actions,
            refs,
        ));
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
    let has_failure_status = card.has_failure_status || card.failure_status.is_some();
    let store_resolved = !fact_owned
        && stored.is_some_and(|s| s.resolved_state == "resolved")
        && !unsupported_retry
        && !has_failure_status;
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
    if let Some(failure_status) = card.failure_status {
        obj.insert("failureStatus".into(), failure_status);
    }
    if let Some(recovery_action) = card.recovery_action {
        obj.insert("recoveryAction".into(), recovery_action);
    }
    if let Some(completion_review) = card.completion_review {
        obj.insert("completionReview".into(), completion_review);
    }
    if !resolved && let Some(recovery) = card.recovery {
        obj.insert("recovery".into(), recovery);
        if let Some(work_state) = card.recovery_work_state {
            obj.insert("recoveryWorkState".into(), work_state);
        }
    }
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

/// Append a non-authoritative card resolution line to `<data_home>/project-runtime/<ws>/cards.jsonl`.
pub fn append_card_resolution(
    data_home: &Path,
    workspace_id: &str,
    resolution: &CardResolution,
) -> Result<(), ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("INVALID_WORKSPACE"));
    }
    let card_id = bounded_id(Some(&resolution.card_id), CARD_ID_MAX);
    if card_id.is_empty() || !matches!(resolution.resolved_state.as_str(), "open" | "resolved") {
        return Err(ProjectError::code("INVALID_INPUT"));
    }
    let runtime_dir = data_home.join("project-runtime").join(workspace_id);
    fs::create_dir_all(&runtime_dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    let file = runtime_dir.join("cards.jsonl");
    let _lock =
        peer_store::DirectoryLock::acquire(&file, std::time::Duration::from_millis(500), None)?;
    let normalized = CardResolution {
        card_id,
        resolved_state: resolution.resolved_state.clone(),
        at: if resolution.at.trim().is_empty() {
            now_iso()
        } else {
            resolution.at.clone()
        },
        resolution: resolution.resolution.clone(),
    };
    let line = serde_json::to_string(&normalized)
        .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    writeln!(f, "{line}").map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    f.sync_all()
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    Ok(())
}

fn finish_projected_cards(built: Vec<DraftCard>, resolutions: &[CardResolution]) -> Vec<Value> {
    let mut stored_by_id: HashMap<&str, &CardResolution> = HashMap::new();
    for record in resolutions {
        if !record.card_id.is_empty()
            && matches!(record.resolved_state.as_str(), "open" | "resolved")
        {
            stored_by_id.insert(record.card_id.as_str(), record);
        }
    }

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
    unique
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

    let mut built = Vec::new();
    build_approval_cards(approvals, &mut built);
    build_plan_approval_cards(approvals, &mut built);
    build_task_question_cards(task_questions, &mut built);
    build_reply_question_cards(replies, &mut built);
    build_confirm_cards(confirmations, &mut built);

    Ok(finish_projected_cards(built, resolutions))
}

/// Read-only canonical workspace card projection combining SQLite coordination facts,
/// approvals, objectives, memories, delegated sessions, and parent history
/// (mirrors `project-facts.mjs#cards` + `card-projection.mjs#projectCards`).
pub fn project_workspace_cards(
    data_home: &Path,
    workspace_id: &str,
    parent_messages: &[Value],
    now_iso_str: &str,
) -> Result<Vec<Value>, ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("INVALID_WORKSPACE"));
    }
    // Check coordination SQLite readiness before any deeper task or parent-history projection.
    let coordination =
        read_coordination_snapshot_readonly(data_home, workspace_id, &["works", "deliveries"])?;
    let empty_bucket = HashMap::new();
    let works_map = coordination.get("works").unwrap_or(&empty_bucket);
    let deliveries_map = coordination.get("deliveries").unwrap_or(&empty_bucket);
    let works: Vec<&Value> = works_map.values().collect();

    let now_fallback;
    let effective_now = if now_iso_str.trim().is_empty() {
        now_fallback = now_iso();
        now_fallback.as_str()
    } else {
        now_iso_str
    };
    let now_ms = parse_iso_ms(effective_now).unwrap_or(0);

    let profile = BotProfileStore::new(data_home).read(workspace_id);
    let approvals = ApprovalStore::new(data_home)
        .list(Some(workspace_id), None)
        .unwrap_or_default();
    let approval_refs: Vec<&Value> = approvals.iter().collect();

    let supervisor = SessionSupervisor::new(data_home, None);
    let plans = supervisor.list_delegated_plans(Some(workspace_id));
    let mut plan_by_session: HashMap<String, &Value> = HashMap::new();
    for (summary, plan) in &plans {
        if !summary.session_id.is_empty() {
            plan_by_session.insert(summary.session_id.clone(), plan);
        }
    }
    let sessions = list_sessions_projected(data_home, Some(workspace_id), None, None, None, None);

    let base_question_states = project_reply_questions(parent_messages, now_ms);
    let has_open_reply_question = base_question_states
        .values()
        .any(|st| st.state == QuestionState::Open);
    let has_waiting_user_session = sessions
        .iter()
        .any(|row| row["status"].as_str() == Some("waiting_user"));
    let queued = if has_open_reply_question || has_waiting_user_session {
        InputQueue::new(data_home)
            .list_unconsumed_meta(workspace_id)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let question_states = if queued.is_empty() {
        base_question_states
    } else {
        project_reply_questions_with_queued(parent_messages, &queued, now_ms)
    };
    let enriched_replies: Vec<Value> = parent_messages
        .iter()
        .filter(|m| m["kind"].as_str() == Some("agent_reply"))
        .map(|m| {
            let mut cloned = m.clone();
            if let Some(q) = cloned.get_mut("question").and_then(Value::as_object_mut)
                && let Some(id) = m["id"].as_str()
                && let Some(st) = question_states.get(id)
            {
                let state_str = match st.state {
                    QuestionState::Open => "open",
                    QuestionState::Answered => "answered",
                    QuestionState::Expired => "expired",
                    QuestionState::Superseded => "superseded",
                };
                q.insert(
                    "answered".to_owned(),
                    json!(st.state != QuestionState::Open),
                );
                q.insert("state".to_owned(), json!(state_str));
            }
            cloned
        })
        .collect();
    let reply_refs: Vec<&Value> = enriched_replies.iter().collect();

    let mut child_msgs_cache: HashMap<String, Vec<Value>> = HashMap::new();
    let mut task_questions = Vec::new();
    let mut confirmations = Vec::new();
    let mut completion_reviews = Vec::new();
    let mut handoffs = Vec::new();

    for row in &sessions {
        let sid = row["sessionId"].as_str().unwrap_or("");
        let status = row["status"].as_str().unwrap_or("");
        let title = row["title"].as_str().unwrap_or("");
        let plan = plan_by_session.get(sid).copied();

        if status == "waiting_user" && !sid.is_empty() {
            let qr = row["queueReason"].as_str().unwrap_or("");
            if matches!(qr, "dependency_failed" | "dependency_missing") {
                let qid = "dependency";
                let answer_to = format!("card:question:{sid}:{qid}");
                task_questions.push(TaskQuestionDraft {
                    session_id: sid.to_owned(),
                    question_id: qid.to_owned(),
                    prompt: format!("「{title}」的前置任务未成功签收。要取消还是重新安排？"),
                    options: vec!["取消这个任务".to_owned(), "重新安排任务".to_owned()],
                    answered: is_answer_recorded(parent_messages, &queued, &answer_to),
                });
            } else if let Some(cid) = row["conversationId"].as_str().filter(|s| !s.is_empty()) {
                let child_msgs = child_msgs_cache
                    .entry(cid.to_owned())
                    .or_insert_with(|| supervisor.child_conversation_messages(cid));
                if let Some((qid, prompt, options)) = latest_task_question(child_msgs) {
                    let answer_to = format!("card:question:{sid}:{qid}");
                    task_questions.push(TaskQuestionDraft {
                        session_id: sid.to_owned(),
                        question_id: qid,
                        prompt,
                        options,
                        answered: is_answer_recorded(parent_messages, &queued, &answer_to),
                    });
                }
            }
        }

        if let Some(p) = plan {
            let can_accept = p["status"].as_str() == Some("completed")
                && (p["runner"]["enabled"].as_bool() != Some(true)
                    || p["runner"]["status"].as_str() == Some("completed"));
            let needs_confirm_card = (status == "result_ready"
                && row["resultConfirmationRequired"].as_bool() == Some(true))
                || status == "accepted";
            if can_accept && needs_confirm_card && !sid.is_empty() {
                confirmations.push(ConfirmCardInput {
                    session_id: sid.to_owned(),
                    summary: title.to_owned(),
                    accepted: status == "accepted",
                    needs_confirm: None,
                });
            }

            if p["delegationOrigin"].is_object()
                && !matches!(
                    p["delegationOrigin"]["phase"].as_str(),
                    Some("paused" | "superseded" | "queued" | "awaiting_approval")
                )
                && !matches!(p["status"].as_str(), Some("failed" | "cancelled"))
                && p["runner"]["status"].as_str() == Some("blocked")
                && p["runner"]["blockedReason"].as_str() == Some("manual_dod_confirmation_required")
            {
                let empty_msgs = Vec::new();
                let child_msgs = if let Some(cid) = p["delegationOrigin"]["workerConversationId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .or_else(|| p["conversationId"].as_str().filter(|s| !s.is_empty()))
                {
                    child_msgs_cache
                        .entry(cid.to_owned())
                        .or_insert_with(|| supervisor.child_conversation_messages(cid))
                        .as_slice()
                } else {
                    empty_msgs.as_slice()
                };
                let report = build_session_report(p, sid, status, child_msgs);
                if let Some(mut review) = project_completion_review_for_plan(p, &report) {
                    if let Some(obj) = review.as_object_mut() {
                        obj.insert("title".into(), json!(title));
                    }
                    completion_reviews.push(review);
                }
            }

            if let Some(handoff_draft) = build_handoff_fact(p, sid) {
                handoffs.push(handoff_draft);
            }
        }
    }

    let resolutions = read_card_resolutions(data_home, workspace_id)?;
    let mut built = Vec::new();
    build_approval_cards(&approval_refs, &mut built);
    build_plan_approval_cards(&approval_refs, &mut built);
    build_task_question_cards(&task_questions, &mut built);
    build_reply_question_cards(&reply_refs, &mut built);
    build_confirm_cards(&confirmations, &mut built);
    build_completion_review_cards(&completion_reviews, &mut built);
    build_readme_cards(
        workspace_id,
        profile.as_ref().and_then(|p| p.readme_offer.as_ref()),
        &mut built,
    );
    build_unavailable_cards(
        data_home,
        workspace_id,
        parent_messages,
        &works,
        deliveries_map,
        &sessions,
        effective_now,
        &mut built,
    );
    build_stopped_cards(parent_messages, &mut built);
    build_memory_conflict_cards(data_home, workspace_id, &mut built);
    build_handoff_cards(&handoffs, &mut built);
    build_objective_proposal_cards(data_home, workspace_id, &mut built);

    Ok(finish_projected_cards(built, &resolutions))
}

struct HandoffFact {
    session_id: String,
    title: String,
    handoff: Value,
    conflict: bool,
    deferred: bool,
    question_id: String,
}

fn build_handoff_fact(plan: &Value, sid: &str) -> Option<HandoffFact> {
    if sid.is_empty() || plan["status"].as_str() != Some("completed") {
        return None;
    }
    let accepted_at = plan["resultAcceptance"]["acceptedAt"]
        .as_str()
        .filter(|s| !s.is_empty())?;
    let worktree_path = plan["deliveryBinding"]["worktreePath"]
        .as_str()
        .filter(|s| !s.is_empty())?;
    if worktree_path.is_empty() {
        return None;
    }
    let handoff = &plan["deliveryHandoff"];
    if matches!(handoff["status"].as_str(), Some("delivered" | "delivering")) {
        return None;
    }
    let conflict = is_handoff_conflict(handoff);
    let updated_at = handoff["updatedAt"].as_str().filter(|s| !s.is_empty());
    let deferred = plan["delegationOrigin"]["handoffDeferredAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .is_some_and(|d| updated_at.is_none_or(|u| u == d));
    let question_id = handoff_question_id(
        accepted_at,
        conflict,
        updated_at,
        handoff["commitSha"].as_str().filter(|s| !s.is_empty()),
        handoff["stoppedReason"].as_str().filter(|s| !s.is_empty()),
    );
    Some(HandoffFact {
        session_id: sid.to_owned(),
        title: plan["title"].as_str().unwrap_or("").to_owned(),
        handoff: handoff.clone(),
        conflict,
        deferred,
        question_id,
    })
}

fn build_completion_review_cards(reviews: &[Value], out: &mut Vec<DraftCard>) {
    for review in reviews {
        let review_token = bounded_id(review["reviewToken"].as_str(), ID_MAX);
        let session_id = bounded_id(review["sessionId"].as_str(), ID_MAX);
        let has_report = review
            .get("report")
            .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()));
        let has_criteria = review["criteria"].as_array().is_some_and(|a| !a.is_empty());
        if review_token.is_empty() || session_id.is_empty() || !has_report || !has_criteria {
            continue;
        }
        let card_id = card_id_of("completion_review", &format!("{session_id}:{review_token}"));
        if card_id.is_empty() {
            continue;
        }
        let confirmed = review["confirmed"].as_bool() == Some(true);
        let action_id = if confirmed {
            "retry_completion"
        } else {
            "confirm_completion"
        };
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "sessionId", None, Some(&session_id));
        let mut card = DraftCard::basic(
            card_id,
            "completion_review",
            clip_text(review["title"].as_str(), "核对报告"),
            false,
            String::new(),
            vec![json!({
                "id": action_id,
                "channel": "project-agent:confirm-result",
                "payload": {
                    "sessionId": session_id,
                    "stage": "manual_completion",
                    "reviewToken": review_token,
                },
            })],
            refs,
        );
        card.completion_review = Some(review.clone());
        out.push(card);
    }
}

fn readme_fact(value: Option<&Value>) -> Option<bool> {
    let v = value?;
    if v.as_bool() == Some(true) {
        return Some(false);
    }
    let obj = v.as_object()?;
    if obj.get("offered").and_then(Value::as_bool) == Some(false)
        || obj.get("pending").and_then(Value::as_bool) == Some(false)
    {
        return None;
    }
    if obj.get("accepted").and_then(Value::as_bool) == Some(true) {
        return Some(true);
    }
    if obj.get("offered").and_then(Value::as_bool) == Some(true)
        || obj.get("pending").and_then(Value::as_bool) == Some(true)
        || obj.get("blank").and_then(Value::as_bool) == Some(true)
    {
        return Some(false);
    }
    None
}

fn build_readme_cards(workspace_id: &str, readme_offer: Option<&Value>, out: &mut Vec<DraftCard>) {
    let Some(accepted) = readme_fact(readme_offer) else {
        return;
    };
    let card_id = card_id_of("readme_offer", workspace_id);
    if card_id.is_empty() {
        return;
    }
    let actions = if accepted {
        Vec::new()
    } else {
        vec![json!({
            "id": "accept_readme",
            "channel": "project-agent:accept-readme",
            "payload": {
                "workspaceId": workspace_id,
                "cardId": card_id,
            },
        })]
    };
    let mut refs = Map::new();
    insert_bounded_ref(&mut refs, "workspaceId", Some(workspace_id), None);
    out.push(DraftCard::basic(
        card_id,
        "readme_offer",
        "要不要为这个项目写一份 README".to_owned(),
        accepted,
        if accepted {
            "accepted".to_owned()
        } else {
            String::new()
        },
        actions,
        refs,
    ));
}

fn compact_branch_name(value: Option<&str>) -> Option<&str> {
    let branch = value.map(str::trim).filter(|s| !s.is_empty())?;
    Some(
        branch
            .strip_prefix("PeerAgent/")
            .filter(|s| !s.is_empty())
            .unwrap_or(branch),
    )
}

fn handoff_target_label(handoff: &Value) -> Option<String> {
    let repo = handoff["repoId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let branch = handoff["targetBranch"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (repo, branch) {
        (Some(r), Some(b)) => Some(format!("{r} / {b}")),
        (None, Some(b)) => Some(b.to_owned()),
        (Some(r), None) => Some(r.to_owned()),
        (None, None) => None,
    }
}

fn format_goal_delivery_handoff_zh(handoff: &Value) -> Option<String> {
    let status = handoff["status"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "idle")?;
    let target = handoff_target_label(handoff);
    let branch = compact_branch_name(handoff["targetBranch"].as_str());
    match status {
        "delivering" => Some(match branch {
            Some(b) => format!("正在合进 {b}"),
            None => "正在合进源头".to_owned(),
        }),
        "delivered" => {
            if handoff["deliveryMode"].as_str() == Some("direct") {
                Some(match target {
                    Some(t) => format!("已随 {t} 交付"),
                    None => "已随源头交付".to_owned(),
                })
            } else {
                Some(match target {
                    Some(t) => format!("已合进 {t}"),
                    None => "已合进源头".to_owned(),
                })
            }
        }
        "stopped" => {
            let dest = branch.unwrap_or("源头");
            let text = match handoff["stoppedReason"].as_str() {
                Some("target_branch_moved") => format!("{dest} 已更新"),
                Some("same_target_busy") => format!("同一目标正在合进 {dest}"),
                Some("merge_conflict") => format!("合并进 {dest} 时发生冲突"),
                Some("target_checkout_dirty") => {
                    format!("你正在 {dest} 上改别的东西，还没提交。没法把这条任务合进去。")
                }
                Some("git_timeout") => format!("合并进 {dest} 超时，可重试"),
                Some("git_lock") => "仓库正被占用，可重试".to_owned(),
                Some("quality_review_pending") => {
                    "质量自检还没过线，没法合进发版线。点「继续修」，把缺的检查补上后再合。"
                        .to_owned()
                }
                Some("missing_task_commits") => {
                    "任务线还没有可合入的提交。改动还在工作区里，先提交再合并。".to_owned()
                }
                Some("missing_worktree") => "找不到这条任务的隔离现场，没法合并。".to_owned(),
                _ => format!("合不进 {dest}"),
            };
            Some(text)
        }
        _ => None,
    }
}

fn build_handoff_cards(handoffs: &[HandoffFact], out: &mut Vec<DraftCard>) {
    for row in handoffs {
        let qid = if row.question_id.is_empty() {
            "handoff"
        } else {
            row.question_id.as_str()
        };
        let card_id = card_id_of("question", &format!("{}:{qid}", row.session_id));
        if card_id.is_empty() {
            continue;
        }
        let reason = format_goal_delivery_handoff_zh(&row.handoff);
        let content = if row.conflict {
            let reason_str = reason
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("合回未成功");
            format!(
                "「{}」{reason_str}。要让任务处理、自己处理，还是放弃？",
                row.title
            )
        } else {
            format!("「{}」已签收。要把改动合回项目吗？", row.title)
        };
        let options: Vec<String> = if row.conflict {
            vec![
                "让任务自己解决".to_owned(),
                "我来处理".to_owned(),
                "放弃这次改动".to_owned(),
            ]
        } else {
            vec!["合回改动".to_owned(), "暂不合回".to_owned()]
        };
        let actions = answer_actions(&card_id, &options);
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "sessionId", Some(&row.session_id), None);
        insert_bounded_ref(&mut refs, "questionId", Some(qid), None);
        out.push(DraftCard::basic(
            card_id,
            "question",
            content,
            row.deferred,
            if row.deferred {
                "deferred".to_owned()
            } else {
                String::new()
            },
            actions,
            refs,
        ));
    }
}

fn build_memory_conflict_cards(data_home: &Path, workspace_id: &str, out: &mut Vec<DraftCard>) {
    let items = MemoryStore::new(data_home).list(&MemoryFilter {
        scope: None,
        workspace_id: Some(workspace_id),
        kind: None,
        status: None,
    });
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<_>> = HashMap::new();
    for item in items {
        if item.status != "conflicted" {
            continue;
        }
        let conflict_id = bounded_id(item.conflict_id.as_deref(), ID_MAX);
        if conflict_id.is_empty() {
            continue;
        }
        if !groups.contains_key(&conflict_id) {
            order.push(conflict_id.clone());
        }
        groups.entry(conflict_id).or_default().push(item);
    }
    for conflict_id in order {
        let Some(group) = groups.get(&conflict_id) else {
            continue;
        };
        if group.len() < 2 {
            continue;
        }
        let card_id = card_id_of("memory_conflict", &conflict_id);
        if card_id.is_empty() {
            continue;
        }
        let summary = group
            .iter()
            .take(2)
            .map(|item| {
                let text_head = utf16_slice(&item.text, 70);
                let src_joined = item.source_refs.join("、");
                let src_head = utf16_slice(&src_joined, 20);
                format!("{text_head}（来源：{src_head}）")
            })
            .collect::<Vec<_>>()
            .join("；");
        let content = clip_text(
            Some(&format!("记忆有冲突，请选择保留哪条：{summary}")),
            "记忆冲突，需要选择",
        );
        let actions = group
            .iter()
            .take(4)
            .map(|item| {
                let text = clip_text(Some(&format!("保留：{}", item.text)), "保留这条");
                json!({
                    "id": "choose_memory",
                    "channel": "project-memory:restore",
                    "payload": {
                        "id": item.id,
                        "resolveConflict": true,
                        "text": text,
                    },
                })
            })
            .collect();
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "conflictId", None, Some(&conflict_id));
        out.push(DraftCard::basic(
            card_id,
            "memory_conflict",
            content,
            false,
            String::new(),
            actions,
            refs,
        ));
    }
}

fn build_objective_proposal_cards(data_home: &Path, workspace_id: &str, out: &mut Vec<DraftCard>) {
    let obj_store = ObjectiveStore::new(data_home);
    let Ok(objectives) = obj_store.list(workspace_id) else {
        return;
    };
    let obj_by_id: HashMap<&str, _> = objectives
        .iter()
        .map(|o| (o.objective_id.as_str(), o))
        .collect();
    let pending = ObjectiveActions::new(data_home).pending(workspace_id);
    for row in pending {
        if row.state != "proposed" {
            continue;
        }
        let Some(item) = obj_by_id.get(row.objective_id.as_str()) else {
            continue;
        };
        if item.status != "active"
            || item.pending_confirmation == Some(true)
            || item.autonomy == "report_only"
            || item.version != row.version
        {
            continue;
        }
        let card_id = card_id_of("question", &format!("objective:{}", row.action_id));
        if card_id.is_empty() {
            continue;
        }
        let title = row.input["title"].as_str().unwrap_or("");
        let brief = row.input["brief"].as_str().unwrap_or("");
        let content = clip_text(
            Some(&format!("「{title}」：{brief}。要开始这个任务吗？")),
            "要开始目标任务吗？",
        );
        let actions = answer_actions(&card_id, &["开始".to_owned(), "暂不".to_owned()]);
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "objectiveId", Some(&row.objective_id), None);
        insert_bounded_ref(&mut refs, "objectiveActionId", Some(&row.action_id), None);
        out.push(DraftCard::basic(
            card_id,
            "question",
            content,
            false,
            String::new(),
            actions,
            refs,
        ));
    }
}

fn build_stopped_cards(parent_messages: &[Value], out: &mut Vec<DraftCard>) {
    for (idx, msg) in parent_messages.iter().enumerate() {
        if msg["card"].as_str() != Some("agent_stopped") {
            continue;
        }
        let turn_id = bounded_id(msg["turnId"].as_str(), ID_MAX);
        if turn_id.is_empty() {
            continue;
        }
        let card_id = card_id_of("agent_stopped", &turn_id);
        if card_id.is_empty() {
            continue;
        }
        let content = msg["content"]
            .as_str()
            .map(|s| utf16_slice(s, 32_000).to_owned())
            .unwrap_or_default();
        let superseded = parent_messages[idx + 1..]
            .iter()
            .any(|later| later["kind"].as_str() == Some("agent_turn"));
        let actions = if superseded {
            Vec::new()
        } else {
            vec![json!({
                "id": "retry",
                "channel": "project-agent:retry",
                "payload": { "turnId": turn_id, "cardId": card_id },
            })]
        };
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "turnId", None, Some(&turn_id));
        out.push(DraftCard::basic(
            card_id,
            "agent_stopped",
            content,
            superseded,
            if superseded {
                "superseded".to_owned()
            } else {
                String::new()
            },
            actions,
            refs,
        ));
    }
}

fn read_recovery_checkpoint(data_home: &Path, workspace_id: &str, ref_str: &str) -> Option<Value> {
    if ref_str.len() != 69
        || !ref_str.ends_with(".json")
        || !ref_str[..64]
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'a'..=b'f'))
    {
        return None;
    }
    let path = data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("checkpoints")
        .join(ref_str);
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn find_work_for_unavailable<'a>(
    msg: &Value,
    turn: Option<&Value>,
    works: &[&'a Value],
) -> Option<&'a Value> {
    let meta_wid = msg["meta"]["workId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            turn.and_then(|t| t["meta"]["workId"].as_str())
                .filter(|s| !s.is_empty())
        });
    if let Some(wid) = meta_wid
        && let Some(found) = works
            .iter()
            .copied()
            .find(|w| w["workId"].as_str() == Some(wid))
    {
        return Some(found);
    }
    let turn_id = msg["turnId"].as_str().filter(|s| !s.is_empty())?;
    works.iter().copied().find(|w| {
        w["recovery"]["failedTurnId"].as_str() == Some(turn_id)
            || w["attemptId"].as_str() == Some(turn_id)
    })
}

fn reply_failure_status<'a>(
    idx: usize,
    msg: &Value,
    parent_messages: &[Value],
    works: &[&'a Value],
    deliveries: &HashMap<String, Value>,
    sessions: &[Value],
    now_iso_str: &str,
) -> (Value, Option<&'a Value>) {
    let msg_turn_id = msg["turnId"].as_str().filter(|s| !s.is_empty());
    let turn = msg_turn_id.and_then(|tid| {
        parent_messages
            .iter()
            .find(|r| r["id"].as_str() == Some(tid) && r["kind"].as_str() == Some("agent_turn"))
    });
    let work = find_work_for_unavailable(msg, turn, works);
    let later = &parent_messages[idx + 1..];

    let recovered = work.and_then(|w| {
        let wid = w["workId"].as_str()?;
        let ic = w.get("intentCoordination").filter(|v| !v.is_null());
        later.iter().find(|r| {
            r["kind"].as_str() == Some("agent_reply")
                && r["turnId"].as_str() != msg_turn_id
                && (r["meta"]["workId"].as_str() == Some(wid)
                    || r["meta"]["intentBindings"]
                        .as_array()
                        .is_some_and(|b| b.iter().any(|x| x["workId"].as_str() == Some(wid))))
                && ic.is_none_or(|coord| {
                    r["meta"]["intentScopes"].as_array().is_some_and(|s| {
                        s.iter().any(|x| {
                            x["workId"].as_str() == Some(wid)
                                && x["goalRevision"] == coord["goalRevision"]
                        })
                    })
                })
                && r["id"]
                    .as_str()
                    .and_then(|id| deliveries.get(id))
                    .is_some_and(|d| d["state"].as_str() == Some("delivered"))
        })
    });
    let newer = work.is_some_and(|w| {
        let Some(wid) = w["workId"].as_str() else {
            return false;
        };
        later.iter().any(|r| {
            r["kind"].as_str() == Some("agent_turn")
                && r["turnId"].as_str() != msg_turn_id
                && r["id"].as_str() != msg_turn_id
                && r["meta"]["workId"].as_str() == Some(wid)
        })
    });
    let active_sessions: Vec<Value> = work
        .and_then(|w| w["sessionIds"].as_array())
        .map(|w_sids| {
            let sid_set: HashSet<&str> = w_sids.iter().filter_map(Value::as_str).collect();
            sessions
                .iter()
                .filter(|row| {
                    row["sessionId"]
                        .as_str()
                        .is_some_and(|sid| sid_set.contains(sid))
                        && matches!(
                            row["status"].as_str(),
                            Some("queued" | "starting" | "running" | "verifying")
                        )
                })
                .filter_map(|row| row["sessionId"].as_str().map(|s| json!(s)))
                .collect()
        })
        .unwrap_or_default();

    let reserved = work.is_some_and(|w| {
        let res_id = w["recovery"]["reservationId"]
            .as_str()
            .filter(|s| !s.is_empty());
        let deadline_ok = matches!(
            (
                w["recovery"]["deadlineAt"].as_str().and_then(parse_iso_ms),
                parse_iso_ms(now_iso_str),
            ),
            (Some(d), Some(n)) if d > n
        );
        w["state"].as_str() == Some("retry_wait")
            && res_id.is_some_and(|rid| {
                w["waitFor"].as_array().is_some_and(|arr| {
                    arr.iter().any(|wait| {
                        wait["kind"].as_str() == Some("retry_timer")
                            && wait["id"].as_str() == Some(rid)
                    })
                })
            })
            && deadline_ok
    });

    let phase = if work.is_some_and(|w| {
        w["state"].as_str() == Some("cancelled")
            || w["intentCoordination"]["lifecycle"].as_str() == Some("cancelled")
    }) {
        "cancelled"
    } else if work.is_some_and(|w| w["state"].as_str() == Some("paused")) {
        "paused"
    } else if recovered.is_some() {
        "recovered"
    } else if newer {
        "superseded"
    } else if work.is_some_and(|w| w["state"].as_str() == Some("runnable")) || reserved {
        "retrying"
    } else {
        "current"
    };

    let turn_kind = if turn.and_then(|t| t["turnKind"].as_str()) == Some("wake") {
        "wake"
    } else {
        "user"
    };
    let mut obj = Map::new();
    obj.insert("phase".into(), json!(phase));
    obj.insert("turnKind".into(), json!(turn_kind));
    obj.insert("activeSessionIds".into(), Value::Array(active_sessions));
    if let Some(wid) = work
        .and_then(|w| w["workId"].as_str())
        .filter(|s| !s.is_empty())
    {
        obj.insert("workId".into(), json!(wid));
    }
    if let Some(rec_id) = recovered
        .and_then(|r| r["id"].as_str())
        .filter(|s| !s.is_empty())
    {
        obj.insert("recoveredByReplyId".into(), json!(rec_id));
    }
    (Value::Object(obj), work)
}

fn is_truthy_json(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

fn runtime_work_control_held(work: &Value) -> bool {
    if is_truthy_json(work.get("pendingControl")) {
        return true;
    }
    work["stopScope"].as_str() == Some("work")
        && (matches!(work["state"].as_str(), Some("paused" | "cancelled"))
            || work["end"].as_str() == Some("user_stopped"))
}

fn has_unsettled_dispatch(work: &Value) -> bool {
    if work["budget"]["uncertainDispatches"]
        .as_array()
        .is_some_and(|a| !a.is_empty())
    {
        return true;
    }
    work["budget"]["attempts"]
        .as_object()
        .is_some_and(|attempts| {
            attempts.values().any(|attempt| {
                attempt["pendingTools"]
                    .as_array()
                    .is_some_and(|p| !p.is_empty())
            })
        })
}

const BUDGET_CAPS: [(&str, &str); 4] = [
    ("maxModelRequests", "modelRequests"),
    ("maxToolCalls", "toolCalls"),
    ("maxTokens", "tokens"),
    ("maxCostUsd", "costUsd"),
];

fn default_work_budget_limits() -> Value {
    json!({
        "schemaVersion": 2,
        "source": "system:progress-continuity-v2",
    })
}

fn is_obsolete_limits(limits: &Value) -> bool {
    limits["source"].as_str() == Some("system:execution-continuity-v1")
        && limits["maxModelRequests"].as_f64() == Some(256.0)
        && limits["maxToolCalls"].as_f64() == Some(2048.0)
        && !limits.get("maxTokens").is_some_and(|v| !v.is_null())
        && !limits.get("maxCostUsd").is_some_and(|v| !v.is_null())
}

fn effective_work_limits(budget: Option<&Value>) -> Value {
    let default_limits = default_work_budget_limits();
    let Some(old) = budget
        .and_then(|b| b.get("limits"))
        .filter(|l| l.is_object())
    else {
        return default_limits;
    };
    let has_cap = BUDGET_CAPS
        .iter()
        .any(|(cap, _)| old.get(*cap).is_some_and(|v| !v.is_null()));
    if !is_obsolete_limits(old) && has_cap {
        old.clone()
    } else {
        default_limits
    }
}

fn budget_boundary(budget: Option<&Value>, limits: &Value) -> Option<Value> {
    let empty = json!({});
    let b = budget.unwrap_or(&empty);
    let mr_positive = b["modelRequests"].as_f64().is_some_and(|n| n > 0.0);
    for (cap, metric) in BUDGET_CAPS {
        let Some(limit_val) = limits.get(cap).filter(|v| !v.is_null()) else {
            continue;
        };
        let limit_num = limit_val.as_f64().filter(|n| n.is_finite() && *n >= 0.0);
        let used_raw = b.get(metric).filter(|v| !v.is_null());
        let used_num = match used_raw {
            None => Some(0.0),
            Some(v) => v.as_f64().filter(|n| n.is_finite() && *n >= 0.0),
        };
        let unknown = (cap == "maxTokens"
            && (b["unknownUsage"].as_bool() == Some(true)
                || (mr_positive && b.get("tokens").is_none_or(Value::is_null))))
            || (cap == "maxCostUsd"
                && (b["unknownCost"].as_bool() == Some(true)
                    || (mr_positive && b.get("costUsd").is_none_or(Value::is_null))));
        let limit_reached = matches!((used_num, limit_num), (Some(u), Some(l)) if u >= l);
        if limit_num.is_none() || used_num.is_none() || unknown || limit_reached {
            let used_json = if used_num.is_some() {
                used_raw.cloned().unwrap_or_else(|| json!(0))
            } else {
                Value::Null
            };
            let source = limits["source"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or("legacy:unknown");
            return Some(json!({
                "metric": metric,
                "used": used_json,
                "limit": limit_val,
                "source": source,
                "reason": if unknown { "usage_unknown" } else { "limit_reached" },
            }));
        }
    }
    None
}

fn budget_reservation_boundary(budget: &Value, limits: &Value) -> Option<Value> {
    let has_cost = limits.get("maxCostUsd").is_some_and(|v| !v.is_null());
    let has_tokens = limits.get("maxTokens").is_some_and(|v| !v.is_null());
    if !has_cost && !has_tokens {
        return None;
    }
    let (metric, cap) = if has_cost {
        ("costUsd", "maxCostUsd")
    } else {
        ("tokens", "maxTokens")
    };
    let used = budget
        .get(metric)
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or_else(|| json!(0));
    Some(json!({
        "metric": metric,
        "used": used,
        "limit": limits[cap],
        "source": limits["source"],
        "reason": "reservation_pending",
    }))
}

fn work_budget_can_resume(work: &Value) -> bool {
    let Some(budget) = work.get("budget").filter(|b| b.is_object()) else {
        return false;
    };
    let Some(previous) = budget.get("limits").filter(|l| l.is_object()) else {
        return false;
    };
    let current = effective_work_limits(Some(budget));
    let migrated =
        is_obsolete_limits(previous) && budget.get("policyMigration").is_none_or(Value::is_null);
    let increased = migrated
        || BUDGET_CAPS.iter().any(|(cap, _)| {
            matches!(
                (previous[*cap].as_f64(), current[*cap].as_f64()),
                (Some(p), Some(c)) if p.is_finite() && c.is_finite() && c > p
            )
        });
    let reservation_released = budget["lastBoundary"]["reason"].as_str()
        == Some("reservation_pending")
        && budget["attempts"].as_object().is_none_or(|a| a.is_empty());
    (increased || reservation_released) && budget_boundary(Some(budget), &current).is_none()
}

fn all_round_calls_settled(outcome: &Value, require_non_null: bool) -> bool {
    let Some(rounds) = outcome["rounds"].as_array() else {
        return true;
    };
    rounds.iter().all(|round| {
        round["toolCalls"].as_array().is_none_or(|calls| {
            calls.iter().all(|call| {
                if require_non_null {
                    call.get("result").is_some_and(|v| !v.is_null())
                } else {
                    call.as_object().is_some_and(|m| m.contains_key("result"))
                }
            })
        })
    })
}

fn recovery_checkpoint_available(
    data_home: &Path,
    workspace_id: &str,
    work: &Value,
    checkpoint: Option<&Value>,
) -> bool {
    let Some(ckpt) = checkpoint.filter(|c| c.is_object()) else {
        return false;
    };
    let outcome = &ckpt["outcome"];
    let rounds = outcome["rounds"].as_array();
    let unsettled = has_unsettled_dispatch(work);

    if work["intentCoordination"]["lifecycle"].as_str() == Some("active")
        && work["intentCoordination"]["decision"]["disposition"]["kind"].as_str()
            == Some("continue")
        && outcome["yielded"].as_bool() != Some(true)
        && !unsettled
        && all_round_calls_settled(outcome, false)
    {
        return true;
    }
    if work["delegationFollowUp"]["blockers"]
        .as_array()
        .is_some_and(|b| !b.is_empty())
        && !is_truthy_json(outcome.get("yielded"))
        && !unsettled
        && all_round_calls_settled(outcome, true)
    {
        return true;
    }
    if work["repairSessionIds"]
        .as_array()
        .is_some_and(|s| !s.is_empty())
        && outcome["failed"].as_bool() != Some(true)
        && outcome["yielded"].as_bool() != Some(true)
        && outcome["stopped"].as_bool() != Some(true)
        && !unsettled
        && all_round_calls_settled(outcome, false)
    {
        return true;
    }
    if work["state"].as_str() == Some("runnable")
        && work["waitFor"]
            .as_array()
            .is_some_and(|w| w.iter().any(|x| x["kind"].as_str() == Some("resource")))
        && is_truthy_json(ckpt.get("outcome"))
        && !is_truthy_json(outcome.get("failed"))
        && !is_truthy_json(outcome.get("yielded"))
        && !is_truthy_json(outcome.get("stopped"))
        && !unsettled
        && all_round_calls_settled(outcome, false)
    {
        return true;
    }
    let executed = rounds.is_some_and(|rs| {
        rs.iter()
            .any(|r| r["toolCalls"].as_array().is_some_and(|c| !c.is_empty()))
    });
    if let Some(native_ref) = work["nativeCheckpointRef"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        return read_recovery_checkpoint(data_home, workspace_id, native_ref)
            .is_some_and(|v| v.is_object());
    }
    !executed
        || is_truthy_json(work.get("nativeCheckpointRef"))
        || is_truthy_json(outcome.get("providerCheckpoint"))
}

fn reply_recovery_admission(
    data_home: &Path,
    workspace_id: &str,
    work: Option<&Value>,
    checkpoint: Option<&Value>,
) -> Value {
    let fail = |code: &str, budget: Option<Value>| -> Value {
        let mut obj = Map::new();
        obj.insert("ok".into(), json!(false));
        obj.insert("code".into(), json!(code));
        if let Some(b) = budget {
            obj.insert("budget".into(), b);
        }
        Value::Object(obj)
    };

    if work.is_some_and(|w| {
        w["recovery"]["blockedCode"].as_str() == Some("COORDINATION_RECONCILIATION_REQUIRED")
    }) {
        return fail("COORDINATION_RECONCILIATION_REQUIRED", None);
    }
    let Some(w) = work else {
        return fail("STALE_TURN", None);
    };
    let state = w["state"].as_str().unwrap_or("");
    if matches!(
        state,
        "delivered" | "cancelled" | "waiting_user" | "coalesced"
    ) {
        return fail("STALE_TURN", None);
    }
    if runtime_work_control_held(w) {
        return fail("STALE_TURN", None);
    }
    if state == "waiting_children"
        && !(w["stopScope"].as_str() == Some("reply")
            && checkpoint.and_then(|c| c["outcome"]["stopped"].as_bool()) == Some(true))
    {
        return fail("STALE_TURN", None);
    }
    if has_unsettled_dispatch(w)
        || w["recovery"]["failureKind"].as_str() == Some("execution_outcome_unknown")
    {
        return fail("EXECUTION_OUTCOME_UNKNOWN", None);
    }
    if w["delegationFollowUp"]["blockers"]
        .as_array()
        .is_some_and(|b| {
            b.iter()
                .any(|row| row["error"].as_str() == Some("execution_outcome_unknown"))
        })
    {
        return fail("EXECUTION_OUTCOME_UNKNOWN", None);
    }

    let effective = effective_work_limits(w.get("budget"));
    if let Some(boundary) = budget_boundary(w.get("budget"), &effective) {
        return fail("WORK_BUDGET_EXHAUSTED", Some(boundary));
    }
    if state == "budget_limited" && !work_budget_can_resume(w) {
        let budget =
            if w["budget"]["lastBoundary"]["reason"].as_str() == Some("reservation_pending") {
                budget_reservation_boundary(&w["budget"], &effective)
            } else {
                w["budget"]
                    .get("lastBoundary")
                    .filter(|v| !v.is_null())
                    .cloned()
            };
        return fail("WORK_BUDGET_EXHAUSTED", budget);
    }
    if !recovery_checkpoint_available(data_home, workspace_id, w, checkpoint) {
        return fail("RECOVERY_CHECKPOINT_UNAVAILABLE", None);
    }
    if checkpoint.and_then(|c| c["job"]["workId"].as_str()) != w["workId"].as_str() {
        return fail("STALE_TURN", None);
    }
    let mut ok_obj = Map::new();
    ok_obj.insert("ok".into(), json!(true));
    if w["budget"]["lastBoundary"]["reason"].as_str() == Some("reservation_pending")
        && let Some(b) = budget_reservation_boundary(&w["budget"], &effective)
    {
        ok_obj.insert("budget".into(), b);
    }
    Value::Object(ok_obj)
}

#[allow(clippy::too_many_arguments)]
fn build_unavailable_cards(
    data_home: &Path,
    workspace_id: &str,
    parent_messages: &[Value],
    works: &[&Value],
    deliveries: &HashMap<String, Value>,
    sessions: &[Value],
    now_iso_str: &str,
    out: &mut Vec<DraftCard>,
) {
    for (idx, msg) in parent_messages.iter().enumerate() {
        if msg["card"].as_str() != Some("agent_unavailable") {
            continue;
        }
        let turn_id = bounded_id(msg["turnId"].as_str(), ID_MAX);
        if turn_id.is_empty() {
            continue;
        }
        let card_id = card_id_of("agent_unavailable", &turn_id);
        if card_id.is_empty() {
            continue;
        }
        let (failure_status, work) = reply_failure_status(
            idx,
            msg,
            parent_messages,
            works,
            deliveries,
            sessions,
            now_iso_str,
        );
        let phase = failure_status["phase"].as_str().unwrap_or("current");
        let superseded = matches!(phase, "superseded" | "recovered" | "cancelled" | "paused");
        let work_state = work.and_then(|w| w["state"].as_str());
        let terminal = matches!(
            work_state,
            Some("delivered" | "cancelled" | "waiting_user" | "coalesced")
        );
        let checkpoint = if !superseded && !terminal {
            work.and_then(|w| w["checkpointRef"].as_str())
                .and_then(|r| read_recovery_checkpoint(data_home, workspace_id, r))
        } else {
            None
        };
        let admission = if superseded || terminal {
            json!({ "ok": false, "code": "STALE_TURN" })
        } else {
            reply_recovery_admission(data_home, workspace_id, work, checkpoint.as_ref())
        };
        let can_continue = !superseded && admission["ok"].as_bool() == Some(true);
        let mut recovery_action = Map::new();
        recovery_action.insert("canContinue".into(), json!(can_continue));
        if admission["ok"].as_bool() != Some(true)
            && let Some(code) = admission["code"].as_str().filter(|s| !s.is_empty())
        {
            recovery_action.insert("blockedReason".into(), json!(code));
        }
        if let Some(budget) = admission.get("budget").filter(|v| !v.is_null()) {
            recovery_action.insert("budget".into(), budget.clone());
        }

        let recovery = if !superseded {
            work.and_then(|w| w.get("recovery"))
                .filter(|r| r.is_object())
                .map(|r| {
                    let mut cloned = r.clone();
                    if let Some(obj) = cloned.as_object_mut()
                        && let Some(res_id) = obj.get("reservationId").and_then(Value::as_str).map(str::to_owned)
                        && !res_id.is_empty()
                    {
                        let still_active_wait = work_state == Some("retry_wait")
                            && work.is_some_and(|w| {
                                w["waitFor"].as_array().is_some_and(|arr| {
                                    arr.iter().any(|wait| {
                                        wait["kind"].as_str() == Some("retry_timer")
                                            && wait["id"].as_str() == Some(res_id.as_str())
                                    })
                                })
                            })
                            && matches!(
                                (
                                    obj.get("deadlineAt").and_then(Value::as_str).and_then(parse_iso_ms),
                                    parse_iso_ms(now_iso_str),
                                ),
                                (Some(d), Some(n)) if d > n
                            );
                        if !still_active_wait {
                            obj.remove("retryAt");
                            obj.remove("reservationId");
                        }
                    }
                    cloned
                })
        } else {
            None
        };

        let raw_reason = msg["content"]
            .as_str()
            .map(|s| s.strip_prefix("代理暂时不可用：").unwrap_or(s));
        let reason = clip_text(raw_reason, "未知原因");
        let actions = if !can_continue {
            Vec::new()
        } else {
            vec![json!({
                "id": "retry",
                "channel": "project-agent:retry",
                "payload": { "turnId": turn_id, "cardId": card_id },
            })]
        };
        let mut refs = Map::new();
        insert_bounded_ref(&mut refs, "turnId", None, Some(&turn_id));
        out.push(DraftCard {
            card_id,
            kind: "agent_unavailable",
            content: format!("代理暂时不可用：{reason}"),
            fact_resolved: superseded,
            fact_state: if superseded {
                phase.to_owned()
            } else {
                String::new()
            },
            has_failure_status: true,
            failure_status: Some(failure_status),
            recovery_action: Some(Value::Object(recovery_action)),
            completion_review: None,
            recovery,
            recovery_work_state: work_state.map(|s| json!(s)),
            actions,
            refs,
        });
    }
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
    project_waiting_user_question_cards_with_queued(
        data_home,
        workspace_id,
        parent_messages,
        &[],
        waiting_sessions,
        resolutions,
    )
}

pub fn project_waiting_user_question_cards_with_queued(
    data_home: &Path,
    workspace_id: &str,
    parent_messages: &[Value],
    queued: &[QueuedInputMeta],
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
            let answered = is_answer_recorded(parent_messages, queued, &answer_to);
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
        let answered = is_answer_recorded(parent_messages, queued, &answer_to);
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

    fn setup_coordination_sqlite(
        data_home: &Path,
        workspace_id: &str,
        entries: &[(&str, &str, Value)],
    ) {
        let rt_dir = data_home.join("project-runtime").join(workspace_id);
        let rm_dir = rt_dir.join(".read-models");
        fs::create_dir_all(&rm_dir).unwrap();
        let db_name = "coordination-11111111-2222-3333-4444-555555555555.sqlite";
        fs::write(
            rm_dir.join("coordination-current.json"),
            serde_json::to_string(&json!({ "schemaVersion": 1, "file": db_name })).unwrap(),
        )
        .unwrap();
        let conn = rusqlite::Connection::open(rm_dir.join(db_name)).unwrap();
        conn.execute(
            "CREATE TABLE objects (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (bucket, id))",
            [],
        )
        .unwrap();
        for (bucket, id, value) in entries {
            conn.execute(
                "INSERT INTO objects VALUES (?, ?, ?)",
                rusqlite::params![bucket, id, serde_json::to_string(value).unwrap()],
            )
            .unwrap();
        }
    }

    #[test]
    fn project_workspace_cards_fails_closed_on_missing_or_corrupt_coordination_index() {
        let dir = tempfile::tempdir().unwrap();
        let ws = "ws-coord-err";
        let rt = dir.path().join("project-runtime").join(ws);
        fs::create_dir_all(rt.join("coordination-v2")).unwrap();

        let err = project_workspace_cards(dir.path(), ws, &[], "2026-11-22T00:00:00Z").unwrap_err();
        assert_eq!(err.code, "coordination_index_missing");

        fs::create_dir_all(rt.join(".read-models")).unwrap();
        fs::write(
            rt.join(".read-models/coordination-current.json"),
            r#"{"schemaVersion":1,"file":"../escape.sqlite"}"#,
        )
        .unwrap();
        let err = project_workspace_cards(dir.path(), ws, &[], "2026-11-22T00:00:00Z").unwrap_err();
        assert_eq!(err.code, "coordination_index_corrupt");
    }

    #[test]
    fn project_workspace_cards_projects_all_workspace_card_kinds() {
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path();
        let ws = "ws-cards-all";
        let profiles = BotProfileStore::new(data_home);
        let (mut profile, _) = profiles
            .create(&crate::CreateBotProfile {
                workspace_id: ws,
                display_name: "Cards Bot",
                managed: false,
                agent_conversation_id: "p-conv",
                avatar_salt: "",
            })
            .unwrap();
        profile.readme_offer = Some(json!({ "offered": true }));
        let profile = profiles.save(profile).unwrap();

        // Memory conflict
        let mem_dir = data_home.join("projects").join(ws).join("memory");
        fs::create_dir_all(&mem_dir).unwrap();
        fs::write(
            mem_dir.join("items.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::to_string(&json!({
                    "id": "mem-1",
                    "scope": "project",
                    "kind": "fact",
                    "text": "Use sqlite WAL mode",
                    "trust": "stated",
                    "sourceRefs": ["conv-1"],
                    "pinned": false,
                    "status": "conflicted",
                    "confirmedCount": 1,
                    "createdAt": "2026-11-22T00:00:00Z",
                    "updatedAt": "2026-11-22T00:00:00Z",
                    "workspaceId": ws,
                    "conflictId": "conf-1",
                }))
                .unwrap(),
                serde_json::to_string(&json!({
                    "id": "mem-2",
                    "scope": "project",
                    "kind": "fact",
                    "text": "Use DELETE journal mode",
                    "trust": "stated",
                    "sourceRefs": ["conv-2"],
                    "pinned": false,
                    "status": "conflicted",
                    "confirmedCount": 1,
                    "createdAt": "2026-11-22T00:01:00Z",
                    "updatedAt": "2026-11-22T00:01:00Z",
                    "workspaceId": ws,
                    "conflictId": "conf-1",
                }))
                .unwrap(),
            ),
        )
        .unwrap();

        // Objective + proposed objective action
        let obj_proj_dir = data_home.join("projects").join(ws).join("objectives");
        fs::create_dir_all(&obj_proj_dir).unwrap();
        fs::write(
            obj_proj_dir.join("objectives.json"),
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "items": [{
                    "objectiveId": "obj-1",
                    "workspaceId": ws,
                    "projectAgentConversationId": profile.agent_conversation_id.as_deref().unwrap_or("pconv"),
                    "originMessageId": "msg-0",
                    "title": "CI Watch",
                    "outcome": "Green CI",
                    "autonomy": "propose",
                    "createdBy": "user",
                    "status": "active",
                    "createdAt": "2026-11-22T00:00:00Z",
                    "updatedAt": "2026-11-22T00:00:00Z",
                    "version": 3
                }],
                "requests": {}
            }))
            .unwrap(),
        )
        .unwrap();
        let obj_rt_dir = data_home
            .join("project-runtime")
            .join(ws)
            .join("objectives");
        fs::create_dir_all(&obj_rt_dir).unwrap();
        fs::write(
            obj_rt_dir.join("actions-state.json"),
            serde_json::to_string(&json!({
                "schemaVersion": 1,
                "items": [{
                    "actionId": "act-1",
                    "workspaceId": ws,
                    "objectiveId": "obj-1",
                    "version": 3,
                    "eventIds": [],
                    "input": { "title": "Fix lint", "brief": "Run clippy" },
                    "createdAt": "2099-01-01T00:00:00Z",
                    "mode": "proposal",
                    "state": "proposed"
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        // Plans: 1) completion_review blocked; 2) handoff merge_conflict
        let convs = ConversationStore::new(data_home);
        let child_meta = convs
            .create_classic_conversation(&json!({
                "title": "Completion Review Child",
                "workspaceId": ws,
            }))
            .unwrap();
        let actual_child_id = child_meta["id"].as_str().unwrap().to_owned();
        convs
            .append_classic_message(
                &actual_child_id,
                &json!({
                    "id": "c-msg-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Manual verification summary ready",
                    "createdAt": "2026-11-22T00:00:10Z",
                }),
            )
            .unwrap();

        let plan_dir = data_home.join("goal-plans");
        fs::create_dir_all(&plan_dir).unwrap();
        let plan_cr = json!({
            "planId": "plan-cr",
            "title": "Review Task",
            "goal": "Confirm manual DoD",
            "status": "executing",
            "conversationId": actual_child_id,
            "delegationOrigin": {
                "workspaceId": ws,
                "sessionId": "sess-cr",
                "parentConversationId": "p-conv",
                "phase": "running",
            },
            "runner": {
                "enabled": true,
                "status": "blocked",
                "blockedReason": "manual_dod_confirmation_required",
            },
            "successCriteria": [
                { "id": "crit-manual", "kind": "manual", "description": "Check screenshot" }
            ],
            "tasks": [],
        });
        let plan_handoff = json!({
            "planId": "plan-handoff",
            "title": "Handoff Task",
            "goal": "Merge branch",
            "status": "completed",
            "conversationId": "conv-missing-ok",
            "delegationOrigin": {
                "workspaceId": ws,
                "sessionId": "sess-ho",
                "parentConversationId": "p-conv",
                "phase": "completed",
            },
            "runner": { "enabled": true, "status": "completed" },
            "resultAcceptance": { "acceptedAt": "2026-11-22T00:02:00Z", "acceptedBy": "auto" },
            "deliveryBinding": {
                "executionIsolation": "worktree",
                "worktreePath": "/tmp/wt-ho",
                "targetBranch": "PeerAgent/main",
            },
            "deliveryHandoff": {
                "status": "stopped",
                "stoppedReason": "merge_conflict",
                "updatedAt": "2026-11-22T00:03:00Z",
            },
            "tasks": [],
        });
        fs::write(
            plan_dir.join("plan-cr.json"),
            serde_json::to_string(&plan_cr).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("plan-handoff.json"),
            serde_json::to_string(&plan_handoff).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("index.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::to_string(&plan_cr).unwrap(),
                serde_json::to_string(&plan_handoff).unwrap()
            ),
        )
        .unwrap();

        // Checkpoints + works + deliveries for unavailable cards
        let ckpt_dir = data_home
            .join("project-runtime")
            .join(ws)
            .join("checkpoints");
        fs::create_dir_all(&ckpt_dir).unwrap();
        let ckpt_a = format!("{:0>64}.json", "a");
        let ckpt_b = format!("{:0>64}.json", "b");
        fs::write(
            ckpt_dir.join(&ckpt_a),
            serde_json::to_string(&json!({
                "job": { "workId": "work-ok" },
                "outcome": { "rounds": [], "providerCheckpoint": { "token": "p1" } }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            ckpt_dir.join(&ckpt_b),
            serde_json::to_string(&json!({
                "job": { "workId": "work-budget" },
                "outcome": { "rounds": [] }
            }))
            .unwrap(),
        )
        .unwrap();

        setup_coordination_sqlite(
            data_home,
            ws,
            &[
                (
                    "works",
                    "work-ok",
                    json!({
                        "workId": "work-ok",
                        "workspaceId": ws,
                        "state": "blocked_system",
                        "checkpointRef": ckpt_a,
                        "recovery": {
                            "failedTurnId": "turn-ok",
                            "failureKind": "transient",
                            "deadlineAt": "2099-01-01T00:05:00Z",
                            "reservationId": "res-expired",
                        },
                    }),
                ),
                (
                    "works",
                    "work-rec",
                    json!({
                        "workId": "work-rec",
                        "workspaceId": ws,
                        "state": "blocked_system",
                        "intentCoordination": { "goalRevision": 4 },
                    }),
                ),
                (
                    "works",
                    "work-budget",
                    json!({
                        "workId": "work-budget",
                        "workspaceId": ws,
                        "state": "budget_limited",
                        "checkpointRef": ckpt_b,
                        "budget": {
                            "modelRequests": 2,
                            "limits": { "maxModelRequests": 2, "source": "settings:execution-budget" },
                        },
                    }),
                ),
                ("deliveries", "reply-rec", json!({ "state": "delivered" })),
            ],
        );

        let parent_msgs = vec![
            json!({
                "id": "u-ok",
                "kind": "system_card",
                "card": "agent_unavailable",
                "turnId": "turn-ok",
                "content": "代理暂时不可用：上游超时",
                "meta": { "workId": "work-ok" },
            }),
            // Runner appends the failed turn's own `agent_turn` right after its `agent_unavailable`
            // card; that same-turn record must NOT self-supersede the failure card into retired history.
            json!({
                "id": "turn-ok",
                "turnId": "turn-ok",
                "kind": "agent_turn",
                "turnKind": "wake",
                "meta": { "workId": "work-ok" },
            }),
            json!({
                "id": "u-rec",
                "kind": "system_card",
                "card": "agent_unavailable",
                "turnId": "turn-rec-1",
                "content": "代理暂时不可用：短暂中断",
                "meta": { "workId": "work-rec" },
            }),
            json!({
                "id": "u-budget",
                "kind": "system_card",
                "card": "agent_unavailable",
                "turnId": "turn-budget",
                "content": "代理暂时不可用：预算已满",
                "meta": { "workId": "work-budget" },
            }),
            json!({
                "id": "s-1",
                "kind": "system_card",
                "card": "agent_stopped",
                "turnId": "turn-stop-open",
                "content": "已按你的要求停下来",
            }),
            json!({
                "id": "reply-rec",
                "kind": "agent_reply",
                "turnId": "turn-rec-2",
                "content": "Recovered",
                "meta": {
                    "workId": "work-rec",
                    "intentScopes": [{ "workId": "work-rec", "goalRevision": 4 }],
                },
            }),
        ];

        let cards =
            project_workspace_cards(data_home, ws, &parent_msgs, "2026-11-22T00:00:00Z").unwrap();
        let by_id: HashMap<&str, &Value> = cards
            .iter()
            .filter_map(|c| c["cardId"].as_str().map(|id| (id, c)))
            .collect();

        // 1. Recoverable unavailable card (with expired reservation cleared)
        let cu_ok = by_id["card:agent_unavailable:turn-ok"];
        assert_eq!(cu_ok["resolvedState"], "open");
        assert_eq!(cu_ok["content"], "代理暂时不可用：上游超时");
        assert_eq!(cu_ok["failureStatus"]["phase"], "current");
        assert_eq!(cu_ok["recoveryAction"]["canContinue"], true);
        assert!(cu_ok["recovery"].get("retryAt").is_none());
        assert!(cu_ok["recovery"].get("reservationId").is_none());
        assert_eq!(cu_ok["recoveryWorkState"], "blocked_system");
        assert_eq!(cu_ok["actions"][0]["id"], "retry");

        // 2. Recovered unavailable card
        let cu_rec = by_id["card:agent_unavailable:turn-rec-1"];
        assert_eq!(cu_rec["resolvedState"], "resolved");
        assert_eq!(cu_rec["failureStatus"]["phase"], "recovered");
        assert_eq!(cu_rec["failureStatus"]["recoveredByReplyId"], "reply-rec");
        assert_eq!(cu_rec["actions"], json!([]));

        // 3. Budget exhausted unavailable card
        let cu_budget = by_id["card:agent_unavailable:turn-budget"];
        assert_eq!(cu_budget["recoveryAction"]["canContinue"], false);
        assert_eq!(
            cu_budget["recoveryAction"]["blockedReason"],
            "WORK_BUDGET_EXHAUSTED"
        );
        assert_eq!(cu_budget["actions"], json!([]));

        // 4. Stopped card
        let cs_stop = by_id["card:agent_stopped:turn-stop-open"];
        assert_eq!(cs_stop["resolvedState"], "open");
        assert_eq!(cs_stop["actions"][0]["channel"], "project-agent:retry");

        // 5. Readme offer card
        let cr = by_id[&format!("card:readme_offer:{ws}").as_str()];
        assert_eq!(cr["kind"], "readme_offer");
        assert_eq!(cr["actions"][0]["id"], "accept_readme");

        // 6. Memory conflict card
        let cm = by_id["card:memory_conflict:conf-1"];
        assert_eq!(cm["kind"], "memory_conflict");
        assert_eq!(cm["actions"].as_array().unwrap().len(), 2);

        // 7. Objective proposal card
        let co = by_id["card:question:objective:act-1"];
        assert_eq!(co["kind"], "question");
        assert_eq!(co["actions"][0]["payload"]["text"], "开始");

        // 8. Handoff conflict card
        let ho_qid = handoff_question_id(
            "2026-11-22T00:02:00Z",
            true,
            Some("2026-11-22T00:03:00Z"),
            None,
            Some("merge_conflict"),
        );
        let ch = by_id[&format!("card:question:sess-ho:{ho_qid}").as_str()];
        assert_eq!(ch["actions"][0]["payload"]["text"], "让任务自己解决");

        // 9. Completion review card
        let crv = cards
            .iter()
            .find(|c| c["kind"] == "completion_review")
            .expect("completion_review card");
        assert_eq!(crv["content"], "Review Task");
        assert_eq!(crv["actions"][0]["id"], "confirm_completion");
    }

    #[test]
    fn append_card_resolution_persists_and_reads_back() {
        let dir = tempdir().unwrap();
        let ws = "ws-append-card";
        append_card_resolution(
            dir.path(),
            ws,
            &CardResolution {
                card_id: "card:memory_conflict:c1".to_owned(),
                resolved_state: "resolved".to_owned(),
                at: String::new(),
                resolution: "dismissed".to_owned(),
            },
        )
        .unwrap();
        let rows = read_card_resolutions(dir.path(), ws).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].card_id, "card:memory_conflict:c1");
        assert_eq!(rows[0].resolved_state, "resolved");
        assert_eq!(rows[0].resolution, "dismissed");
        assert!(!rows[0].at.is_empty());
    }

    #[test]
    fn project_workspace_cards_marks_reply_and_task_questions_resolved_when_answer_is_queued() {
        let dir = tempdir().unwrap();
        let data_home = dir.path();
        let ws = "ws-queued-cards";
        setup_coordination_sqlite(data_home, ws, &[]);

        let parent_msgs = vec![json!({
            "id": "reply-q-card",
            "role": "assistant",
            "kind": "agent_reply",
            "content": "Pick one?",
            "createdAt": "2026-11-27T03:01:00.000Z",
            "question": { "options": ["Yes", "No"] }
        })];

        let before =
            project_workspace_cards(data_home, ws, &parent_msgs, "2026-11-27T03:02:00.000Z")
                .unwrap();
        let card_before = before
            .iter()
            .find(|c| c["cardId"] == "card:question:reply:reply-q-card")
            .expect("open reply question card");
        assert_eq!(card_before["resolvedState"], "open");

        InputQueue::new(data_home)
            .submit_input(&crate::SubmitInputRequest {
                workspace_id: ws,
                input_id: "in-card-queued-1",
                surface: "desktop",
                text: "Yes",
                anchor_refs: vec![],
                quote_refs: vec![],
                task_refs: vec![],
                attachment_refs: vec![],
                attachments: vec![],
                answer_to: Some("card:question:reply:reply-q-card".into()),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            })
            .unwrap();

        let after =
            project_workspace_cards(data_home, ws, &parent_msgs, "2026-11-27T03:02:10.000Z")
                .unwrap();
        let card_after = after
            .iter()
            .find(|c| c["cardId"] == "card:question:reply:reply-q-card")
            .expect("resolved reply question card");
        assert_eq!(card_after["resolvedState"], "resolved");
        assert_eq!(card_after["actions"], json!([]));

        // Also verify waiting_user dependency task question closes when answer is queued.
        let waiting = BotListSession {
            session_id: "sess-dep-1".into(),
            title: "Blocked Task".into(),
            status: "waiting_user".into(),
            updated_at: Some("2026-11-27T03:02:00.000Z".into()),
            conversation_id: None,
            plan_id: None,
            anchor_message_id: None,
            phase_label: None,
            queue_reason: Some("dependency_failed".into()),
            result_confirmation_required: None,
            completion_review_required: false,
            follow_up: None,
        };
        let open_task_cards = project_waiting_user_question_cards_with_queued(
            data_home,
            ws,
            &[],
            &[],
            &[&waiting],
            &[],
        );
        assert_eq!(open_task_cards.len(), 1);
        assert_eq!(open_task_cards[0]["resolvedState"], "open");

        let queued_task_ans = vec![QueuedInputMeta {
            input_id: "in-task-ans-1".into(),
            created_at: "2026-11-27T03:02:15.000Z".into(),
            answer_to: Some("card:question:sess-dep-1:dependency".into()),
        }];
        let resolved_task_cards = project_waiting_user_question_cards_with_queued(
            data_home,
            ws,
            &[],
            &queued_task_ans,
            &[&waiting],
            &[],
        );
        assert_eq!(resolved_task_cards.len(), 1);
        assert_eq!(resolved_task_cards[0]["resolvedState"], "resolved");
        assert_eq!(resolved_task_cards[0]["actions"], json!([]));
    }
}
