//! Anchored reply composition (`post_reply`), status-claim verification,
//! factual report deduplication, and `SurfacingPolicy`.
//!
//! Matches `packages/protocol/src/delegation.ts#decideSurfacing` and
//! `packages/runtime-node/src/project-agent/reply-composer.mjs` (ADR 80 §9, ADR 80 B4-R, ADR 88).

use crate::ProjectError;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

const TEXT_MAX: usize = 2000;
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
}

#[derive(Debug, Clone)]
pub struct ComposedReply {
    pub message: Value,
    pub report_fact_keys: Vec<String>,
    pub suppressed_duplicate: bool,
}

/// Validates and assembles a canonical `agent_reply` message.
///
/// Rejects forged source IDs, missing/mismatched `statusClaims`, unverified `result_ready`
/// passed claims, and missing `replyTo` anchors when non-proactive. Deduplicates repeated
/// wake reports over unchanged `reportFactKeys` (ADR 80 B4-R).
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
            "text is required and must be at most 2000 characters",
        ));
    }
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
    for source in &input.sources {
        if !input.project_session_ids.contains(source) {
            return Err(ProjectError::new(
                "forged_sources",
                format!("source session does not belong to project: {source}"),
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
            return Err(ProjectError::code("status_claim_required"));
        }
        let mut seen = HashSet::new();
        for claim in &input.status_claims {
            if !seen.insert(claim.session_id.as_str())
                || !input.sources.contains(&claim.session_id)
                || !WORK_SESSION_STATUSES.contains(&claim.status.as_str())
            {
                return Err(ProjectError::code("status_claim_required"));
            }
            let Some(actual) = facts_by_id.get(claim.session_id.as_str()) else {
                return Err(ProjectError::code("status_claim_required"));
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
        "marks": [],
    });
    if let Some(tid) = input.turn_id {
        message["turnId"] = json!(tid);
    }
    if input.proactive {
        message["proactive"] = json!(true);
    }
    if let Some(q) = input.question {
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
            }],
            memory_used: vec![],
            memory_learned: vec![],
            evidence_refs: vec![],
            surfacing: Surfacing::Message,
            prior_report_fact_keys: HashSet::new(),
        })
        .unwrap_err();
        assert_eq!(err.code, "status_claim_mismatch");
    }
}
