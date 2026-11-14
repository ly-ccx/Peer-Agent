//! Existing goal-plans/evidence-index.jsonl registration seam.
//! Registration records a Host tool result; it does not prove goal acceptance.
use crate::{DirectoryLock, StoreError, durable_jsonl as log};
use peer_protocol::{collect_tool_result_evidence_refs, javascript_trim};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
/// Host-owned execution report, never accepted from a renderer/model endpoint.
/// Deliberately not Deserialize. Tool output and assistant prose are not reports.
pub struct HostToolEvidence<'a> {
    pub conversation_id: &'a str,
    pub plan_id: Option<&'a str>,
    pub stream_id: Option<&'a str>,
    pub tool_name: &'a str,
    pub capability_id: &'a str,
    pub tool_call_id: &'a str,
    pub grant: &'a Value,
    pub result: &'a Value,
}
pub struct EvidenceIndexStore {
    file: PathBuf,
}
fn text(v: &str, max: usize) -> bool {
    !javascript_trim(v).is_empty() && v.len() <= max
}
fn validate_report(report: &HostToolEvidence<'_>) -> Result<(), StoreError> {
    let bad = StoreError::EvidenceInvalid;
    let result = report.result;
    let grant = report.grant;
    if !text(report.conversation_id, 200)
        || !text(report.tool_name, 200)
        || !text(report.capability_id, 200)
        || !text(report.tool_call_id, 200)
        || report.plan_id.is_some_and(|s| !text(s, 200))
        || report.stream_id.is_some_and(|s| !text(s, 200))
        || result["toolCallId"].as_str() != Some(report.tool_call_id)
        || grant["toolCallId"].as_str() != Some(report.tool_call_id)
        || !grant["grantId"].as_str().is_some_and(|s| text(s, 200))
        || !grant["granted"].is_boolean()
        || !result["outputPreview"].is_object()
        || !["success", "failed", "denied", "cancelled"]
            .contains(&result["status"].as_str().unwrap_or(""))
        || result["status"] == "success" && grant["granted"] != true
        || result["evidence"]["toolCallId"].as_str() != Some(report.tool_call_id)
        || !result["evidence"]["evidenceId"]
            .as_str()
            .is_some_and(|s| text(s, 200))
        || !result["evidence"]["summary"].is_string()
        || !result["evidence"]["artifactRefs"].is_array()
    {
        return Err(bad);
    }
    for at in [&result["completedAt"], &grant["decidedAt"]] {
        if !at.as_str().is_some_and(|s| {
            s.len() <= 64
                && time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339)
                    .is_ok()
        }) {
            return Err(bad);
        }
    }
    if !["once", "task", "session", "scope", "persistent", "denied"]
        .contains(&grant["duration"].as_str().unwrap_or(""))
        || grant["granted"] == false && grant["duration"] != "denied"
        || grant["granted"] == true && grant["duration"] == "denied"
    {
        return Err(bad);
    }
    Ok(())
}
fn validate_record(row: &Value) -> Result<(), StoreError> {
    if !row["evidenceRef"].as_str().is_some_and(|s| text(s, 8192))
        || !row["createdAt"].as_str().is_some_and(|s| text(s, 200))
    {
        return Err(StoreError::EvidenceInvalid);
    }
    for key in [
        "planId",
        "conversationId",
        "streamId",
        "toolCallId",
        "capabilityId",
        "toolName",
    ] {
        if let Some(v) = row.get(key)
            && !v.as_str().is_some_and(|s| text(s, 200))
        {
            return Err(StoreError::EvidenceInvalid);
        }
    }
    Ok(())
}
impl EvidenceIndexStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            file: data_home.as_ref().join("goal-plans/evidence-index.jsonl"),
        }
    }
    /// Bounded, strict source facts. Missing refs remain missing, never success.
    pub fn find(
        &self,
        refs: &[String],
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<Value>, StoreError> {
        if refs.len() > 1024 || refs.iter().any(|r| !text(r, 8192)) {
            return Err(StoreError::EvidenceInvalid);
        }
        let wanted: HashSet<_> = refs.iter().map(String::as_str).collect();
        let mut found = HashMap::new();
        for row in log::read(&self.file, cancel)? {
            validate_record(&row)?;
            let id = row["evidenceRef"].as_str().unwrap();
            if wanted.contains(id) {
                // Generic facts use the existing merge order. Complex interactive receipts
                // must be reconciled by their canonical adapter before native mutation.
                let merged = match found.remove(id) {
                    Some(old) => merge(old, &row)?,
                    None => row,
                };
                found.insert(merged["evidenceRef"].as_str().unwrap().to_owned(), merged);
            }
        }
        Ok(refs.iter().filter_map(|r| found.get(r).cloned()).collect())
    }
    pub fn register(
        &self,
        report: &HostToolEvidence<'_>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<Value>, StoreError> {
        log::check_cancel(cancel)?;
        validate_report(report)?;
        let refs = collect_tool_result_evidence_refs(Some(report.tool_call_id), report.result)
            .map_err(|_| StoreError::HistoryLimit)?;
        if report.result["evidence"]["artifactRefs"]
            .as_array()
            .unwrap()
            .len()
            > 1024
        {
            return Err(StoreError::HistoryLimit);
        }
        let artifacts: Vec<_> = report.result["evidence"]["artifactRefs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v.as_str()
                    .map(javascript_trim)
                    .filter(|s| text(s, 8192))
                    .ok_or(StoreError::EvidenceInvalid)
            })
            .collect::<Result<_, _>>()?;
        let parent = log::directory(self.file.parent().unwrap())?;
        let file = parent.join("evidence-index.jsonl");
        let _lock = DirectoryLock::acquire(&file, Duration::from_millis(100), cancel)?;
        let mut history = log::read(&file, cancel)?;
        for row in &history {
            validate_record(row)?;
        }
        let mut existing = HashMap::<String, Value>::new();
        let wanted: HashSet<_> = refs.iter().map(String::as_str).collect();
        for old in &history {
            let key = old["evidenceRef"].as_str().unwrap();
            if wanted.contains(key) {
                let row = match existing.remove(key) {
                    Some(previous) => merge(previous, old)?,
                    None => old.clone(),
                };
                existing.insert(key.to_owned(), row);
            }
        }
        let mut saved = Vec::new();
        let mut changes = Vec::new();
        for evidence_ref in refs {
            let mut row = json!({"evidenceRef":evidence_ref,"createdAt":report.result["completedAt"],"conversationId":report.conversation_id,"toolCallId":report.tool_call_id,"capabilityId":report.capability_id,"toolName":report.tool_name});
            if let Some(plan) = report.plan_id {
                row["planId"] = json!(plan)
            }
            if let Some(stream) = report.stream_id {
                row["streamId"] = json!(stream)
            }
            if !artifacts.is_empty() {
                row["artifactRefs"] = json!(artifacts)
            }
            let previous = existing.remove(&evidence_ref);
            let merged = if let Some(old) = previous.as_ref() {
                merge(old.clone(), &row)?
            } else {
                row
            };
            if previous.as_ref() != Some(&merged) {
                changes.push(merged.clone());
            }
            saved.push(merged);
        }
        if !changes.is_empty() {
            history.extend(changes.iter().cloned());
            log::encode(&history)?;
            log::append(&file, &log::encode(&changes)?, cancel)?;
        }
        Ok(saved)
    }
}
fn interactive(row: &Value) -> bool {
    row.get("interactiveInspection").is_some()
        || row["userArtifacts"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(|r| r["kind"] == "interactive"))
}
fn merge(mut current: Value, incoming: &Value) -> Result<Value, StoreError> {
    if interactive(&current) || interactive(incoming) {
        return Err(StoreError::EvidenceUnsupported);
    }
    // Same generic record merge as goal-plan-files.mjs; unknown source fields stay.
    if current.get("bodyPreview").is_none()
        && incoming.get("bodyPreview").is_some()
        && incoming["toolName"] != "goal_update_task"
    {
        current["bodyPreview"] = incoming["bodyPreview"].clone()
    }
    for key in ["planId", "conversationId", "streamId"] {
        if let Some(v) = incoming.get(key) {
            current[key] = v.clone()
        }
    }
    if current["toolName"].as_str().is_none_or(str::is_empty)
        || current["toolName"] == "goal_update_task" && incoming["toolName"] != "goal_update_task"
    {
        for key in ["toolCallId", "capabilityId", "toolName", "createdAt"] {
            if let Some(v) = incoming.get(key) {
                current[key] = v.clone()
            }
        }
    } else if incoming["toolName"] != "goal_update_task" {
        for key in ["toolCallId", "capabilityId", "toolName"] {
            if current.get(key).is_none()
                && let Some(v) = incoming.get(key)
            {
                current[key] = v.clone()
            }
        }
    }
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    for row in [&current, incoming] {
        if let Some(items) = row["artifactRefs"].as_array() {
            for item in items {
                let r = item.as_str().ok_or(StoreError::EvidenceInvalid)?;
                let r = javascript_trim(r);
                if text(r, 8192) && seen.insert(r) {
                    refs.push(json!(r))
                }
            }
        }
    }
    if !refs.is_empty() {
        current["artifactRefs"] = json!(refs)
    }
    let mut users = Vec::<Value>::new();
    for row in [&current, incoming] {
        if let Some(items) = row["userArtifacts"].as_array() {
            for artifact in items {
                if let Some(reference) = artifact["ref"].as_str() {
                    if let Some(old) = users.iter_mut().find(|r| r["ref"] == reference) {
                        *old = artifact.clone()
                    } else {
                        users.push(artifact.clone())
                    }
                }
            }
        }
    }
    if !users.is_empty() {
        current["userArtifacts"] = json!(users)
    }
    Ok(current)
}
