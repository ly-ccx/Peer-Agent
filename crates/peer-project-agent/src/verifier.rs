//! Work-session capability profile intersections and Independent Read-Only Verifier
//! (`packages/runtime-node/src/project-agent/work-session-profile.mjs`,
//! `verifier-report.mjs`, `verifier-lifecycle.mjs`, ADR 80 / ADR 88 / ADR 103).

use crate::ProjectError;
use peer_protocol::LocalAccessLevel;
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model::NativeModel,
    providers::RuntimeMode,
    session_host::{LocalPermissionDecision, PermissionInput},
};
use peer_store::EvidenceIndexStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

const MAX_VERIFIER_TEXT: usize = 100_000;
const MAX_REPAIR_TEXT: usize = 4_000;

pub const WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES: [&str; 4] = [
    "local.web.control.",
    "local.delegation.",
    "local.objective.",
    "local.memory.",
];

pub const READ_ONLY_CAPABILITY_CEILING: [&str; 6] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.git.query",
    "local.search.aggregate",
    "local.tool-result.read",
];

pub const WORKER_CAPABILITY_CEILING: [&str; 11] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.git.query",
    "local.search.aggregate",
    "local.tool-result.read",
    "local.file.write",
    "local.file.edit",
    "local.shell.exec",
    "local.shell.stop",
    "local.web.fetch",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkSessionProfile {
    pub agent_kind: String,
    pub read_only: bool,
    pub access_level: LocalAccessLevel,
    pub allowlist: Vec<String>,
    pub exclude_prefixes: Vec<&'static str>,
}

fn is_excluded_capability(cap: &str) -> bool {
    WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES
        .iter()
        .any(|prefix| cap.starts_with(prefix))
}

/// Computes the governed capability profile for a delegated work-session role
/// (`"worker"`, `"explorer"`, `"verifier"`). Intersects requested capabilities
/// against strict role ceilings and never admits control/delegation/write caps
/// in read-only roles.
pub fn resolve_work_session_profile(
    plan: &Value,
    agent_kind: &str,
    workspace_access: LocalAccessLevel,
) -> Option<WorkSessionProfile> {
    let origin = plan["delegationOrigin"].as_object()?;
    let read_only_origin = origin
        .get("readOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let read_only = matches!(agent_kind, "verifier" | "explorer") || read_only_origin;

    let ceiling: &[&str] = if read_only {
        &READ_ONLY_CAPABILITY_CEILING
    } else {
        &WORKER_CAPABILITY_CEILING
    };
    let requested: Vec<String> = origin
        .get("requiredCapabilities")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty() && !is_excluded_capability(c))
        .filter(|c| ceiling.contains(c))
        .map(str::to_owned)
        .collect();

    let mut allowlist = Vec::new();
    let mut seen = HashSet::new();
    let push_unique = |item: String, list: &mut Vec<String>, set: &mut HashSet<String>| {
        if set.insert(item.clone()) {
            list.push(item);
        }
    };

    if read_only {
        if requested.is_empty() {
            for &cap in &READ_ONLY_CAPABILITY_CEILING {
                push_unique(cap.to_owned(), &mut allowlist, &mut seen);
            }
        } else {
            for cap in requested {
                push_unique(cap, &mut allowlist, &mut seen);
            }
            push_unique(
                "local.tool-result.read".to_owned(),
                &mut allowlist,
                &mut seen,
            );
        }
    } else {
        for &cap in [
            "local.file.read",
            "local.file.list",
            "local.file.search",
            "local.git.query",
            "local.tool-result.read",
        ]
        .iter()
        {
            push_unique((*cap).to_owned(), &mut allowlist, &mut seen);
        }
        for cap in requested {
            push_unique(cap, &mut allowlist, &mut seen);
        }
    }

    Some(WorkSessionProfile {
        agent_kind: agent_kind.to_owned(),
        read_only,
        access_level: if read_only {
            LocalAccessLevel::SessionLocal
        } else {
            workspace_access
        },
        allowlist,
        exclude_prefixes: WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES.to_vec(),
    })
}

pub fn model_family(model_id: &str) -> String {
    let lower = model_id.trim().to_lowercase();
    let stripped = lower.rsplit('/').next().unwrap_or(&lower).trim();
    for prefix in [
        "claude", "gpt", "o1", "o3", "o4", "gemini", "deepseek", "qwen", "glm", "kimi", "llama",
        "mistral",
    ] {
        if stripped.starts_with(prefix) {
            return prefix.to_owned();
        }
    }
    stripped
        .split(['-', '_', ':', '.'])
        .find(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierIssue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub criterion_id: Option<String>,
    pub reason: String,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifierReport {
    pub passed: bool,
    #[serde(default)]
    pub failed_criteria: Vec<VerifierIssue>,
    #[serde(default)]
    pub missing_evidence: Vec<VerifierIssue>,
    #[serde(default)]
    pub risks: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_next_action: Option<String>,
}

#[derive(Debug, Clone)]
pub enum VerifierOutcome {
    Verified {
        report: VerifierReport,
        verifier_conversation_id: String,
        verifier_model_id: String,
        same_family_as_worker: bool,
        verifier_evidence_refs: Vec<String>,
    },
    InvalidReport {
        error: &'static str,
        summary: String,
        verifier_conversation_id: String,
    },
}

fn extract_balanced_top_level_objects(text: &str) -> Option<Vec<Value>> {
    let mut objects = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_quotes = false;
    let mut escaped = false;

    for (idx, ch) in text.char_indices() {
        if start.is_none() {
            if ch == '{' {
                start = Some(idx);
                depth = 1;
            }
            continue;
        }
        if in_quotes {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_quotes = false;
            }
        } else if ch == '"' {
            in_quotes = true;
        } else if ch == '{' {
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0
                && let Some(s) = start.take()
            {
                let parsed = serde_json::from_str::<Value>(&text[s..=idx]).ok()?;
                objects.push(parsed);
            }
        }
    }
    if start.is_some() {
        return None;
    }
    Some(objects)
}

fn clean_string_list(val: Option<&Value>) -> Option<Vec<String>> {
    let Some(v) = val else {
        return Some(Vec::new());
    };
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        let s = item.as_str()?.trim();
        if !s.is_empty() {
            out.push(s.to_owned());
        }
    }
    Some(out)
}

fn clean_issue_list(val: Option<&Value>) -> Option<Vec<VerifierIssue>> {
    let Some(v) = val else {
        return Some(Vec::new());
    };
    let arr = v.as_array()?;
    let mut out = Vec::new();
    for item in arr {
        let obj = item.as_object()?;
        let reason = obj.get("reason").and_then(Value::as_str)?.trim();
        if reason.is_empty() {
            return None;
        }
        let task_id = match obj.get("taskId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return None,
        };
        let criterion_id = match obj.get("criterionId") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return None,
        };
        let evidence_refs = clean_string_list(obj.get("evidenceRefs"))?;
        out.push(VerifierIssue {
            task_id,
            criterion_id,
            reason: reason.to_owned(),
            evidence_refs,
        });
    }
    Some(out)
}

/// Decodes a structured JSON verifier report matching `verifier-report.mjs#decodeVerifierReport`.
pub fn decode_verifier_report(text: &str) -> Option<VerifierReport> {
    let trimmed = text.trim();
    if trimmed.is_empty() || text.chars().count() > MAX_VERIFIER_TEXT {
        return None;
    }
    let candidates = match serde_json::from_str::<Value>(trimmed) {
        Ok(val) => vec![val],
        Err(_) => extract_balanced_top_level_objects(text)?,
    };
    if candidates.len() != 1 {
        return None;
    }
    let report = candidates.into_iter().next()?;
    let obj = report.as_object()?;
    let passed = obj.get("passed").and_then(Value::as_bool)?;
    let failed_criteria = clean_issue_list(obj.get("failedCriteria"))?;
    let missing_evidence = clean_issue_list(obj.get("missingEvidence"))?;
    let risks = clean_string_list(obj.get("risks"))?;
    let evidence_refs = clean_string_list(obj.get("evidenceRefs"))?;
    if passed && evidence_refs.is_empty() {
        return None;
    }
    let summary = match obj.get("summary") {
        None | Some(Value::Null) => {
            if passed {
                "Verifier passed.".to_owned()
            } else {
                "Verifier found issues.".to_owned()
            }
        }
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                if passed {
                    "Verifier passed.".to_owned()
                } else {
                    "Verifier found issues.".to_owned()
                }
            } else {
                t.to_owned()
            }
        }
        _ => return None,
    };
    let recommended_next_action = match obj.get("recommendedNextAction") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_owned())
        }
        _ => return None,
    };

    Some(VerifierReport {
        passed,
        failed_criteria,
        missing_evidence,
        risks,
        evidence_refs,
        summary,
        recommended_next_action,
    })
}

struct DenyEscalationPermission;

impl PermissionInput for DenyEscalationPermission {
    fn decide<'a>(
        &'a mut self,
        _prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async { LocalPermissionDecision::Deny })
    }
}

fn build_verifier_prompt(
    plan: &Value,
    allowed_refs: &HashSet<String>,
    previous_text: Option<&str>,
) -> String {
    let title = plan["title"].as_str().unwrap_or("");
    let goal = plan["goal"].as_str().unwrap_or("");
    let worker_output = plan["delegationOrigin"]["lastWorkerOutput"]
        .as_str()
        .unwrap_or("");
    let criteria_json =
        serde_json::to_string(&plan["successCriteria"]).unwrap_or_else(|_| "[]".into());
    let mut known_list: Vec<&str> = allowed_refs.iter().map(String::as_str).collect();
    known_list.sort();
    let known_json = serde_json::to_string(&known_list).unwrap_or_else(|_| "[]".into());

    let mut prompt = format!(
        "You are an independent read-only Verification Reviewer.\n\
         Verify the completed delegated session strictly against persisted disk state and indexed host Evidence.\n\
         Never modify files or assume worker prose is true without verifying.\n\n\
         Task Title: {title}\n\
         Goal / Brief: {goal}\n\
         Success Criteria: {criteria_json}\n\
         Known Worker Evidence Refs: {known_json}\n\
         Worker Output Summary:\n{worker_output}\n\n\
         Respond with ONE valid JSON object (no extra JSON objects) matching:\n\
         {{\"passed\": boolean, \"failedCriteria\": [{{\"criterionId\": \"...\", \"reason\": \"...\", \"evidenceRefs\": [\"...\"]}}], \"missingEvidence\": [], \"risks\": [], \"evidenceRefs\": [\"...\"], \"summary\": \"...\"}}"
    );
    if let Some(prev) = previous_text.map(str::trim).filter(|s| !s.is_empty()) {
        let clipped: String = prev.chars().take(MAX_REPAIR_TEXT).collect();
        prompt.push_str(&format!(
            "\n\nYour previous verifier output could not be decoded or cited unindexed evidenceRefs:\n{clipped}\n\
             Return ONE valid JSON object citing ONLY real evidenceRefs from your tool calls or Known Worker Evidence Refs."
        ));
    }
    prompt
}

/// Runs the bounded, read-only Independent Verifier episode (up to 2 attempts: initial + 1 format repair).
pub async fn run_independent_verifier(
    data_home: &Path,
    plan: &Value,
    worker_evidence_refs: &HashSet<String>,
    verifier_model: &NativeModel,
    cancel: &CancellationToken,
) -> Result<VerifierOutcome, ProjectError> {
    let target_ws = plan["targetWorkspacePath"]
        .as_str()
        .or_else(|| plan["originWorkspacePath"].as_str())
        .map(PathBuf::from)
        .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
    let profile = resolve_work_session_profile(plan, "verifier", LocalAccessLevel::SessionLocal)
        .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;

    let worker_model_id = plan["delegationOrigin"]["modelSelection"]["worker"]["modelId"]
        .as_str()
        .or_else(|| plan["delegationOrigin"]["modelSelection"]["worker"].as_str())
        .unwrap_or("");
    let verifier_model_id = verifier_model.model_id().to_owned();
    let same_family_as_worker = !worker_model_id.is_empty()
        && model_family(worker_model_id) == model_family(&verifier_model_id);

    let evidence_store = EvidenceIndexStore::new(data_home);
    let mut allowed_refs = worker_evidence_refs.clone();
    let mut verifier_ev_refs = Vec::new();
    let mut previous_text: Option<String> = None;
    let mut last_conv_id = String::new();

    for attempt in 0..2 {
        if cancel.is_cancelled() {
            return Err(ProjectError::code("CANCELLED"));
        }
        let prompt = build_verifier_prompt(plan, &allowed_refs, previous_text.as_deref());
        let runtime = NativeConversationRuntime::new(
            data_home,
            ConversationAccess::new(LocalAccessLevel::SessionLocal),
        );
        let mut deny_perm = DenyEscalationPermission;
        let conv_out = Box::pin(runtime.execute(
            &ConversationOptions {
                workspace: &target_ws,
                conversation_id: None,
                resume_from: None,
                prompt: &prompt,
                image_paths: &[],
                provider_id: verifier_model.provider(),
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: Some(&profile.allowlist),
                max_turns: Some(8),
            },
            verifier_model,
            &mut deny_perm,
            cancel,
        ))
        .await?;

        last_conv_id = conv_out.session_id.clone();
        if let Ok(rows) = evidence_store.list_for_conversation(&last_conv_id, None) {
            for row in rows {
                if let Some(r) = row["evidenceRef"].as_str().map(str::trim)
                    && !r.is_empty()
                {
                    let owned = r.to_owned();
                    allowed_refs.insert(owned.clone());
                    if !verifier_ev_refs.contains(&owned) {
                        verifier_ev_refs.push(owned);
                    }
                }
            }
        }
        if conv_out.error == Some("permission_denied") {
            return Err(ProjectError::code("verifier_permission_denied"));
        }
        if conv_out.error.is_some() {
            return Err(ProjectError::code(
                conv_out.error.unwrap_or("verifier_failed"),
            ));
        }

        if let Some(report) = decode_verifier_report(&conv_out.content) {
            let refs_valid = !report.passed
                || report
                    .evidence_refs
                    .iter()
                    .all(|r| allowed_refs.contains(r.as_str()));
            if refs_valid {
                return Ok(VerifierOutcome::Verified {
                    report,
                    verifier_conversation_id: last_conv_id,
                    verifier_model_id,
                    same_family_as_worker,
                    verifier_evidence_refs: verifier_ev_refs,
                });
            }
        }
        if attempt == 0 {
            previous_text = Some(conv_out.content);
        }
    }

    Ok(VerifierOutcome::InvalidReport {
        error: "verifier_report_invalid",
        summary: "Verifier returned no valid structured report after one retry.".to_owned(),
        verifier_conversation_id: last_conv_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn profile_enforces_strict_read_only_and_worker_ceilings() {
        let plan = json!({
            "delegationOrigin": {
                "readOnly": false,
                "requiredCapabilities": [
                    "local.file.write",
                    "local.delegation.spawn_session",
                    "local.web.control.click",
                    "local.file.read"
                ]
            }
        });
        let worker = resolve_work_session_profile(&plan, "worker", LocalAccessLevel::FullLocal)
            .expect("worker profile");
        assert!(!worker.read_only);
        assert!(worker.allowlist.contains(&"local.file.write".to_owned()));
        assert!(
            !worker
                .allowlist
                .contains(&"local.delegation.spawn_session".to_owned())
        );
        assert!(
            !worker
                .allowlist
                .contains(&"local.web.control.click".to_owned())
        );

        let verifier = resolve_work_session_profile(&plan, "verifier", LocalAccessLevel::FullLocal)
            .expect("verifier profile");
        assert!(verifier.read_only);
        assert_eq!(verifier.access_level, LocalAccessLevel::SessionLocal);
        assert!(!verifier.allowlist.contains(&"local.file.write".to_owned()));
        assert!(verifier.allowlist.contains(&"local.file.read".to_owned()));
        assert!(
            verifier
                .allowlist
                .contains(&"local.tool-result.read".to_owned())
        );
    }

    #[test]
    fn decode_verifier_report_handles_fenced_single_and_rejects_ambiguous_or_unbacked() {
        // Requires evidenceRefs when passed == true
        assert!(decode_verifier_report(r#"{"passed":true,"evidenceRefs":[]}"#).is_none());

        // Rejects ambiguous multiple top-level JSON objects
        assert!(
            decode_verifier_report(
                r#"{"passed":false,"summary":"first"} {"passed":true,"evidenceRefs":["ev-1"]}"#
            )
            .is_none()
        );

        // Extracts single JSON object surrounded by prose and braces in quoted summary
        let parsed = decode_verifier_report(
            "Here is my audit:\n```json\n{\"passed\": true, \"evidenceRefs\": [\"ev-1\"], \"summary\": \"checked {a:b} ok\"}\n```",
        )
        .expect("single balanced JSON object");
        assert!(parsed.passed);
        assert_eq!(parsed.evidence_refs, vec!["ev-1"]);
        assert_eq!(parsed.summary, "checked {a:b} ok");
    }

    #[test]
    fn model_family_normalizes_common_prefixes() {
        assert_eq!(model_family("anthropic/claude-sonnet-4"), "claude");
        assert_eq!(model_family("gpt-5.2-codex"), "gpt");
        assert_eq!(model_family("deepseek-v3"), "deepseek");
    }
}
