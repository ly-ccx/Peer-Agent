//! Anchored reply composition (`post_reply`), status-claim verification,
//! factual report deduplication, and `SurfacingPolicy`.
//!
//! Matches `packages/protocol/src/delegation.ts#decideSurfacing` and
//! `packages/runtime-node/src/project-agent/reply-composer.mjs` (ADR 80 §9, ADR 80 B4-R, ADR 88).

use crate::{ProjectError, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

pub(crate) const TEXT_MAX: usize = 32_000;
const OUTCOMES: [&str; 4] = ["passed", "failed", "partial", "unverifiable"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAnchorCandidate {
    pub message_id: String,
    pub input_id: Option<String>,
    pub text: String,
}

fn available_anchor_diagnostics(candidates: &[UserAnchorCandidate]) -> Vec<Value> {
    let start = candidates.len().saturating_sub(5);
    candidates[start..]
        .iter()
        .map(|c| {
            let preview: String = c.text.chars().take(120).collect();
            json!({
                "messageId": c.message_id,
                "text": preview,
            })
        })
        .collect()
}

/// Resolve supplied user anchor references (`messageId` or raw `inputId` -> `"input-<id>"`),
/// returning structured `availableReplyAnchors` diagnostics on miss or ambiguity.
pub fn resolve_user_anchors(
    supplied: &[String],
    candidates: &[UserAnchorCandidate],
) -> Result<Vec<String>, (ProjectError, Value)> {
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();
    for raw in supplied {
        let id = raw.trim();
        if id.is_empty() {
            return Err((
                ProjectError::new("invalid_input", "anchor ID must not be empty"),
                json!({
                    "messageIds": [raw],
                    "availableReplyAnchors": available_anchor_diagnostics(candidates),
                }),
            ));
        }
        let mut matches: Vec<&UserAnchorCandidate> =
            candidates.iter().filter(|c| c.message_id == id).collect();
        if matches.is_empty() {
            matches = candidates
                .iter()
                .filter(|c| c.input_id.as_deref() == Some(id))
                .collect();
        }
        if matches.is_empty() {
            return Err((
                ProjectError::new(
                    "anchor_not_found",
                    format!("Anchor message was not found: {id}"),
                ),
                json!({
                    "messageIds": [id],
                    "availableReplyAnchors": available_anchor_diagnostics(candidates),
                }),
            ));
        }
        if matches.len() > 1 {
            return Err((
                ProjectError::new(
                    "anchor_ambiguous",
                    format!("Anchor identity is ambiguous: {id}"),
                ),
                json!({
                    "messageIds": [id],
                    "availableReplyAnchors": available_anchor_diagnostics(candidates),
                }),
            ));
        }
        let resolved_id = matches[0].message_id.clone();
        if seen.insert(resolved_id.clone()) {
            resolved.push(resolved_id);
        }
    }
    Ok(resolved)
}
const WORK_SESSION_STATUSES: [&str; 14] = [
    "paused",
    "queued",
    "starting",
    "running",
    "waiting_user",
    "waiting_agent",
    "stopping",
    "awaiting_outcome",
    "verifying",
    "result_ready",
    "accepted",
    "failed",
    "cancelled",
    "superseded",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surfacing {
    Interrupt,
    Message,
    Digest,
    Silent,
}

impl Surfacing {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Interrupt => "interrupt",
            Self::Message => "message",
            Self::Digest => "digest",
            Self::Silent => "silent",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfacingEvent {
    pub origin: String,
    pub kind: String,
    pub novelty: bool,
    pub severity: String,
    pub deadline_imminent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SurfacingDecision {
    pub decision: Surfacing,
    pub reason: &'static str,
}

pub fn normalize_proactivity(level: Option<&str>) -> &'static str {
    match level.unwrap_or("standard") {
        "off" | "muted" | "quiet" => "off",
        "low" => "low",
        "high" => "high",
        _ => "normal",
    }
}

pub(crate) fn result_fact_key(session_id: &str, revision: &str) -> String {
    format!("session:{session_id}:result_ready:{revision}")
}

/// Only a formal reply citing this terminal revision is proof of delivery.
pub(crate) fn reports_result_revision(message: &Value, session_id: &str, revision: &str) -> bool {
    if revision.is_empty()
        || message["role"] != "assistant"
        || message["kind"] != "agent_reply"
        || ![&message["sources"], &message["meta"]["sources"]]
            .iter()
            .any(|sources| {
                sources
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| id == session_id))
            })
    {
        return false;
    }
    let key = result_fact_key(session_id, revision);
    message["meta"]["reportFactKeys"]
        .as_array()
        .is_some_and(|keys| keys.iter().any(|fact| fact == &key))
        || message["meta"]["sessionStates"]
            .as_array()
            .is_some_and(|states| {
                states.iter().any(|row| {
                    row["sessionId"] == session_id
                        && matches!(row["status"].as_str(), Some("result_ready" | "completed"))
                        && row["sourceRevision"] == revision
                })
            })
}

/// Top-to-bottom surfacing policy table from ADR 80 §9 / `delegation.ts#decideSurfacing`.
pub fn decide_surfacing(
    event: &SurfacingEvent,
    proactivity: &str,
    quiet_hours: bool,
    needs_you: bool,
) -> SurfacingDecision {
    let proactivity = normalize_proactivity(Some(proactivity));
    let is_attention = matches!(
        event.kind.as_str(),
        "needs_user" | "confirm" | "failure_needs_decision" | "objective_risk"
    );
    if needs_you || is_attention {
        let stays_interrupt = event.kind == "objective_risk" && event.deadline_imminent;
        if quiet_hours && !stays_interrupt {
            return SurfacingDecision {
                decision: Surfacing::Message,
                reason: "quiet_hours",
            };
        }
        return SurfacingDecision {
            decision: Surfacing::Interrupt,
            reason: if needs_you && !is_attention {
                "needs_you"
            } else {
                "attention"
            },
        };
    }
    if event.origin == "user_request" && event.kind == "result" {
        return SurfacingDecision {
            decision: if matches!(proactivity, "normal" | "high") {
                Surfacing::Interrupt
            } else {
                Surfacing::Message
            },
            reason: "user_result",
        };
    }
    let agent_origin = matches!(event.origin.as_str(), "agent_idea" | "objective_signal");
    if agent_origin && !event.novelty {
        return SurfacingDecision {
            decision: Surfacing::Silent,
            reason: "not_novel",
        };
    }
    if agent_origin && event.severity == "urgent" {
        return SurfacingDecision {
            decision: Surfacing::Interrupt,
            reason: "agent_urgent",
        };
    }
    if agent_origin && event.severity == "notable" {
        let decision = match proactivity {
            "high" => Surfacing::Interrupt,
            "normal" => Surfacing::Message,
            _ => Surfacing::Digest,
        };
        return SurfacingDecision {
            decision,
            reason: "agent_notable",
        };
    }
    if agent_origin && (event.severity == "info" || event.kind == "idea") {
        let decision = match proactivity {
            "high" => Surfacing::Message,
            "off" => Surfacing::Silent,
            _ => Surfacing::Digest,
        };
        return SurfacingDecision {
            decision,
            reason: "agent_info",
        };
    }
    SurfacingDecision {
        decision: Surfacing::Message,
        reason: "default",
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusFact {
    pub session_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub independent_verifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusClaim {
    pub session_id: String,
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct ComposeReplyInput {
    pub message_id: String,
    pub turn_id: Option<String>,
    pub kind: String,
    pub text: String,
    pub reply_to: Vec<String>,
    pub sources: Vec<String>,
    pub status_claims: Vec<StatusClaim>,
    pub proactive: bool,
    pub question: Option<Value>,
    pub valid_user_message_ids: HashSet<String>,
    pub project_session_ids: HashSet<String>,
    pub session_facts: Vec<SessionStatusFact>,
    pub memory_used: Vec<String>,
    pub memory_learned: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub surfacing: Surfacing,
    pub prior_report_fact_keys: HashSet<String>,
    pub unreported_anchor_sessions: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct ComposedReply {
    pub message: Value,
    pub report_fact_keys: Vec<String>,
    pub suppressed_duplicate: bool,
}

fn validate_question(raw: &Value) -> Result<Value, ProjectError> {
    let Some(obj) = raw.as_object() else {
        return Err(ProjectError::new(
            "invalid_input",
            "question must be an object",
        ));
    };
    let mut out = Map::new();
    if let Some(opts_val) = obj.get("options") {
        let Some(arr) = opts_val.as_array() else {
            return Err(ProjectError::new(
                "invalid_input",
                "question.options must contain 1 to 8 choices",
            ));
        };
        if arr.is_empty() || arr.len() > 8 {
            return Err(ProjectError::new(
                "invalid_input",
                "question.options must contain 1 to 8 choices",
            ));
        }
        let mut deduped = Vec::new();
        let mut seen = HashSet::new();
        for item in arr {
            let Some(opt) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                return Err(ProjectError::new(
                    "invalid_input",
                    "question.options items must be non-empty strings",
                ));
            };
            if opt.chars().count() > 200 {
                return Err(ProjectError::new(
                    "invalid_input",
                    "question.options item exceeds 200 chars",
                ));
            }
            if seen.insert(opt.to_owned()) {
                deduped.push(Value::String(opt.to_owned()));
            }
        }
        out.insert("options".into(), Value::Array(deduped));
    }
    if let Some(prompt_val) = obj.get("prompt") {
        let Some(p) = prompt_val.as_str() else {
            return Err(ProjectError::new(
                "invalid_input",
                "question.prompt must be a string",
            ));
        };
        if p.chars().count() > 500 {
            return Err(ProjectError::new(
                "invalid_input",
                "question.prompt must be at most 500 chars",
            ));
        }
        out.insert("prompt".into(), json!(p));
    }
    if let Some(exp_val) = obj.get("expiresAt") {
        let Some(exp_str) = exp_val.as_str().filter(|s| parse_iso_ms(s).is_some()) else {
            return Err(ProjectError::new(
                "invalid_input",
                "question.expiresAt must be a valid ISO timestamp",
            ));
        };
        out.insert("expiresAt".into(), json!(exp_str));
    }
    if let Some(req_id) = obj.get("agentRequestId") {
        let Some(id_str) = req_id
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 200 && !s.contains(['\r', '\n']))
        else {
            return Err(ProjectError::new(
                "invalid_input",
                "Invalid linked Agent question.",
            ));
        };
        let rev = obj
            .get("expectedRequestRevision")
            .and_then(Value::as_u64)
            .filter(|&n| n >= 1)
            .ok_or_else(|| ProjectError::new("invalid_input", "Invalid linked Agent question."))?;
        out.insert("agentRequestId".into(), json!(id_str));
        out.insert("expectedRequestRevision".into(), json!(rev));
    }
    Ok(Value::Object(out))
}

/// Validates and assembles a canonical `agent_reply` message.
///
/// Rejects forged source IDs, missing/mismatched `statusClaims`, unverified `result_ready`
/// passed claims, unreported anchor sessions, and missing `replyTo` anchors when non-proactive.
/// Deduplicates repeated wake reports over unchanged `reportFactKeys` (ADR 80 B4-R).
pub fn compose_reply(input: ComposeReplyInput) -> Result<ComposedReply, ProjectError> {
    if input.message_id.trim().is_empty() || input.message_id.len() > 200 {
        return Err(ProjectError::code("invalid_input"));
    }
    if !matches!(input.kind.as_str(), "user" | "wake") {
        return Err(ProjectError::code("invalid_input"));
    }
    let text = input.text.trim();
    if text.is_empty() || text.chars().count() > TEXT_MAX {
        return Err(ProjectError::new(
            "invalid_input",
            format!("text is required and must be at most {TEXT_MAX} characters"),
        ));
    }
    let validated_question = input.question.as_ref().map(validate_question).transpose()?;
    if input.reply_to.is_empty() && !input.proactive {
        return Err(ProjectError::new(
            "reply_to_required",
            "replyTo is required unless proactive is true",
        ));
    }
    for anchor in &input.reply_to {
        if !input.valid_user_message_ids.contains(anchor) {
            return Err(ProjectError::new(
                "invalid_anchor",
                format!("replyTo anchor not found: {anchor}"),
            ));
        }
    }
    for (anchor, sid) in &input.unreported_anchor_sessions {
        if input.reply_to.contains(anchor) && !input.sources.contains(sid) {
            return Err(ProjectError::new(
                "result_source_required",
                format!(
                    "Cite unreported session {sid} for anchor {anchor} before reporting results."
                ),
            ));
        }
    }
    for source in &input.sources {
        if !input.project_session_ids.contains(source) {
            return Err(ProjectError::new(
                "forged_sources",
                format!(
                    "sources must contain only raw delegated sessionIds belonging to this project (not file paths or prefixed refs); invalid entry: {source}"
                ),
            ));
        }
    }

    let facts_by_id: HashMap<&str, &SessionStatusFact> = input
        .session_facts
        .iter()
        .map(|f| (f.session_id.as_str(), f))
        .collect();

    if !input.sources.is_empty() || !input.status_claims.is_empty() {
        if input.status_claims.len() != input.sources.len() {
            return Err(ProjectError::new(
                "status_claim_required",
                format!(
                    "sources ({}) and statusClaims ({}) must match 1:1; cite every claimed sessionId in sources and include one statusClaim per source",
                    input.sources.len(),
                    input.status_claims.len()
                ),
            ));
        }
        let mut seen = HashSet::new();
        for claim in &input.status_claims {
            if !seen.insert(claim.session_id.as_str())
                || !input.sources.contains(&claim.session_id)
                || !WORK_SESSION_STATUSES.contains(&claim.status.as_str())
            {
                return Err(ProjectError::new(
                    "status_claim_required",
                    format!(
                        "invalid statusClaim for sessionId={} status={}; every claim must appear in sources and use an exact host session status",
                        claim.session_id, claim.status
                    ),
                ));
            }
            let Some(actual) = facts_by_id.get(claim.session_id.as_str()) else {
                return Err(ProjectError::new(
                    "status_claim_required",
                    format!(
                        "missing host session status fact for sessionId={}",
                        claim.session_id
                    ),
                ));
            };
            if actual.status != claim.status {
                return Err(ProjectError::new(
                    "status_claim_mismatch",
                    format!(
                        "session {} is {}, not {}",
                        claim.session_id, actual.status, claim.status
                    ),
                ));
            }
        }
    }

    for source in &input.sources {
        if let Some(fact) = facts_by_id.get(source.as_str())
            && fact.status == "result_ready"
            && fact.verdict_outcome.as_deref() == Some("passed")
            && fact.independent_verifier.as_deref() == Some("missing")
        {
            return Err(ProjectError::code("verification_required"));
        }
    }

    let mut report_fact_keys = Vec::new();
    let mut session_states = Vec::new();
    let mut marks = Vec::new();
    let mut latest_verdict_ref: Option<String> = None;
    for source in &input.sources {
        if let Some(fact) = facts_by_id.get(source.as_str()) {
            let rev = fact
                .observation_revision
                .as_deref()
                .or(fact.source_revision.as_deref())
                .unwrap_or("0");
            report_fact_keys.push(format!(
                "session:{}:{}:{}",
                fact.session_id, fact.status, rev
            ));
            let mut row = json!({
                "sessionId": fact.session_id,
                "status": fact.status,
            });
            if let Some(ref sr) = fact.source_revision {
                row["sourceRevision"] = json!(sr);
            }
            if let Some(ref or) = fact.observation_revision {
                row["observationRevision"] = json!(or);
            }
            session_states.push(row);

            if let Some(outcome) = fact
                .verdict_outcome
                .as_deref()
                .filter(|o| OUTCOMES.contains(o))
            {
                let vref = fact.verdict_ref.clone().unwrap_or_else(|| {
                    crate::acceptance::verdict_ref_for(&fact.session_id, outcome)
                });
                marks.push(json!({
                    "sessionId": fact.session_id,
                    "outcome": outcome,
                    "verdictRef": vref,
                }));
                latest_verdict_ref = Some(vref);
            }
        }
    }

    // ADR 80 B4-R: suppress duplicate wake reports when every cited fact key was already reported.
    let suppressed_duplicate = input.kind == "wake"
        && !report_fact_keys.is_empty()
        && report_fact_keys
            .iter()
            .all(|k| input.prior_report_fact_keys.contains(k));

    let mut meta = json!({
        "replyTo": input.reply_to,
        "sources": input.sources,
        "memoryUsed": input.memory_used,
        "memoryLearned": input.memory_learned,
        "surfacing": input.surfacing.as_str(),
    });
    if !session_states.is_empty() {
        meta["sessionStates"] = json!(session_states);
    }
    if let Some(ref vref) = latest_verdict_ref {
        meta["verdictRef"] = json!(vref);
    }
    if !report_fact_keys.is_empty() {
        meta["reportFactKeys"] = json!(report_fact_keys);
    }
    if !input.evidence_refs.is_empty() {
        meta["evidenceRefs"] = json!(input.evidence_refs);
    }

    let mut message = json!({
        "id": input.message_id,
        "role": "assistant",
        "kind": "agent_reply",
        "content": text,
        "replyTo": input.reply_to,
        "sources": input.sources,
        "fallback": false,
        "meta": meta,
        "marks": marks,
    });
    if let Some(tid) = input.turn_id {
        message["turnId"] = json!(tid);
    }
    if input.proactive {
        message["proactive"] = json!(true);
    }
    if let Some(q) = validated_question {
        message["question"] = q;
    }

    Ok(ComposedReply {
        message,
        report_fact_keys,
        suppressed_duplicate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surfacing_and_status_claim_guard_enforce_contract() {
        let dec = decide_surfacing(
            &SurfacingEvent {
                origin: "objective_signal".into(),
                kind: "observation".into(),
                novelty: false,
                severity: "notable".into(),
                deadline_imminent: false,
            },
            "high",
            false,
            false,
        );
        assert_eq!(dec.decision, Surfacing::Silent);

        let err = compose_reply(ComposeReplyInput {
            message_id: "r1".into(),
            turn_id: Some("t1".into()),
            kind: "user".into(),
            text: "Done".into(),
            reply_to: vec!["input-1".into()],
            sources: vec!["s1".into()],
            status_claims: vec![StatusClaim {
                session_id: "s1".into(),
                status: "accepted".into(),
            }],
            proactive: false,
            question: None,
            valid_user_message_ids: ["input-1".into()].into_iter().collect(),
            project_session_ids: ["s1".into()].into_iter().collect(),
            session_facts: vec![SessionStatusFact {
                session_id: "s1".into(),
                status: "running".into(),
                source_revision: Some("rev1".into()),
                observation_revision: None,
                independent_verifier: None,
                verdict_outcome: None,
                verdict_ref: None,
            }],
            memory_used: vec![],
            memory_learned: vec![],
            evidence_refs: vec![],
            surfacing: Surfacing::Message,
            prior_report_fact_keys: HashSet::new(),
            unreported_anchor_sessions: vec![],
        })
        .unwrap_err();
        assert_eq!(err.code, "status_claim_mismatch");
    }

    #[test]
    fn resolves_anchors_populates_verdict_marks_and_enforces_unreported_sources() {
        let candidates = vec![UserAnchorCandidate {
            message_id: "input-u1".into(),
            input_id: Some("u1".into()),
            text: "Build the project".into(),
        }];
        let resolved =
            resolve_user_anchors(&["u1".into(), "input-u1".into()], &candidates).unwrap();
        assert_eq!(resolved, vec!["input-u1"]);

        let (miss_err, diag) = resolve_user_anchors(&["missing".into()], &candidates).unwrap_err();
        assert_eq!(miss_err.code, "anchor_not_found");
        assert_eq!(diag["availableReplyAnchors"][0]["messageId"], "input-u1");

        // Unreported completed session on anchor must be cited
        let missing_src = compose_reply(ComposeReplyInput {
            message_id: "r2".into(),
            turn_id: Some("t2".into()),
            kind: "user".into(),
            text: "Status update".into(),
            reply_to: vec!["input-u1".into()],
            sources: vec![],
            status_claims: vec![],
            proactive: false,
            question: None,
            valid_user_message_ids: ["input-u1".into()].into_iter().collect(),
            project_session_ids: ["s1".into()].into_iter().collect(),
            session_facts: vec![],
            memory_used: vec![],
            memory_learned: vec![],
            evidence_refs: vec![],
            surfacing: Surfacing::Message,
            prior_report_fact_keys: HashSet::new(),
            unreported_anchor_sessions: vec![("input-u1".into(), "s1".into())],
        })
        .unwrap_err();
        assert_eq!(missing_src.code, "result_source_required");

        // Valid cited source emits marks + meta.verdictRef
        let composed = compose_reply(ComposeReplyInput {
            message_id: "r3".into(),
            turn_id: Some("t3".into()),
            kind: "user".into(),
            text: "Verified done.".into(),
            reply_to: vec!["input-u1".into()],
            sources: vec!["s1".into()],
            status_claims: vec![StatusClaim {
                session_id: "s1".into(),
                status: "result_ready".into(),
            }],
            proactive: false,
            question: Some(json!({
                "prompt": "Next?",
                "options": ["Merge", "Merge", "Keep"]
            })),
            valid_user_message_ids: ["input-u1".into()].into_iter().collect(),
            project_session_ids: ["s1".into()].into_iter().collect(),
            session_facts: vec![SessionStatusFact {
                session_id: "s1".into(),
                status: "result_ready".into(),
                source_revision: Some("rev1".into()),
                observation_revision: None,
                independent_verifier: Some("passed".into()),
                verdict_outcome: Some("passed".into()),
                verdict_ref: Some("verdict:s1:passed:v1".into()),
            }],
            memory_used: vec![],
            memory_learned: vec![],
            evidence_refs: vec!["ev-1".into()],
            surfacing: Surfacing::Message,
            prior_report_fact_keys: HashSet::new(),
            unreported_anchor_sessions: vec![("input-u1".into(), "s1".into())],
        })
        .unwrap();
        assert_eq!(composed.message["marks"][0]["outcome"], "passed");
        assert_eq!(
            composed.message["marks"][0]["verdictRef"],
            "verdict:s1:passed:v1"
        );
        assert_eq!(
            composed.message["meta"]["verdictRef"],
            "verdict:s1:passed:v1"
        );
        assert_eq!(
            composed.message["question"]["options"],
            json!(["Merge", "Keep"])
        );
    }
}
