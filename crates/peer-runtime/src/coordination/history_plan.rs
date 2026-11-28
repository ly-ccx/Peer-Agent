//! Pure history resumption planning. Only the Host checkpoint adapter may supply
//! compatible checkpoints; an opaque JS object is never a native resume permit.
use super::value::{list, sorted_digest, truth, values};
use serde_json::{Value, json};
pub trait HistoryRecoveryFacts {
    /// A production adapter must reject incompatible engine/provider formats,
    /// validate original source identity, and bound allocation before returning.
    fn checkpoint(
        &self,
        work_id: &str,
        reference: Option<&str>,
    ) -> Result<Option<Value>, &'static str>;
    fn session_safe(&self, _session_id: &str) -> bool {
        false
    }
}
pub fn history_checkpoint_bindings(work: &Value) -> Result<Vec<Value>, &'static str> {
    peer_protocol::javascript_json_string(work).map_err(|_| "coordination_state_limit")?;
    let mut out = Vec::new();
    if truth(&work["checkpointRef"]) {
        out.push(json!({"ref":work["checkpointRef"],"owner":work["workId"]}));
    }
    for key in
        peer_protocol::javascript_object_keys(&work["budget"]["attempts"]).unwrap_or_default()
    {
        let a = &work["budget"]["attempts"][key];
        if truth(&a["checkpointRef"]) {
            out.push(json!({"ref":a["checkpointRef"],"owner":format!("{}:{key}",work["workId"].as_str().unwrap_or(""))}));
        }
    }
    if truth(&work["nativeCheckpointRef"])
        && !out.iter().any(|r| r["ref"] == work["nativeCheckpointRef"])
    {
        out.push(json!({"ref":work["nativeCheckpointRef"],"owner":work["workId"]}));
    }
    Ok(out)
}
pub fn plan_history_resumption(
    state: &Value,
    inspection: &Value,
    facts: &impl HistoryRecoveryFacts,
) -> Result<Vec<Value>, &'static str> {
    for v in [state, inspection] {
        peer_protocol::javascript_json_string(v).map_err(|_| "coordination_state_limit")?;
    }
    let conflicts = inspection["conflicts"]
        .as_array()
        .ok_or("coordination_recovery_identity_conflict")?;
    if conflicts.iter().any(|c| c["bucket"] != "works") {
        return Err("coordination_recovery_identity_conflict");
    }
    let works = values(&state["works"]);
    let originals = conflicts
        .iter()
        .flat_map(|c| [&c["baseline"], &c["current"], &c["legacy"]])
        .filter(|v| truth(v));
    let mut owners: std::collections::BTreeMap<String, Vec<Value>> =
        std::collections::BTreeMap::new();
    for work in works.iter().copied().chain(originals) {
        for input in list(&work["anchorInputIds"]) {
            let key = input
                .as_str()
                .ok_or("coordination_recovery_identity_conflict")?;
            let ids = owners.entry(key.into()).or_default();
            if !ids.contains(&work["workId"]) {
                ids.push(work["workId"].clone());
            }
        }
    }
    let mut prepared = Vec::new();
    for row in values(&state["deliveries"]) {
        if row["state"] == "prepared" {
            let id = row["message"]["meta"]["workId"]
                .as_str()
                .ok_or("coordination_recovery_unbound_delivery")?;
            if !truth(&state["works"][id]) {
                return Err("coordination_recovery_unbound_delivery");
            }
            prepared.push(id.to_owned());
        }
    }
    let mut out = Vec::new();
    for work in works {
        if matches!(
            work["state"].as_str(),
            Some("delivered" | "cancelled" | "coalesced")
        ) || state["lastRecovery"]["executionBlocked"] == false
            && work["historyRecovery"]["disposition"] != "held"
        {
            continue;
        }
        let previous = work["historyRecovery"]
            .get("previousRecovery")
            .filter(|v| !v.is_null())
            .unwrap_or(&work["recovery"]);
        let previous_state = work["historyRecovery"]
            .get("previousState")
            .filter(|v| !v.is_null())
            .unwrap_or(&work["state"]);
        let id = work["workId"]
            .as_str()
            .ok_or("coordination_recovery_identity_conflict")?;
        let reason = if conflicts.iter().any(|c| c["id"] == work["workId"]) {
            Some("history_conflict")
        } else if list(&work["anchorInputIds"]).iter().any(|input| {
            owners
                .get(input.as_str().unwrap_or(""))
                .is_some_and(|o| o.len() > 1)
        }) {
            Some("input_ownership")
        } else if prepared.iter().any(|w| w == id) {
            Some("delivery_pending")
        } else if values(&state["transitions"]).iter().any(|t| {
            t["workId"] == work["workId"]
                && !matches!(t["phase"].as_str(), Some("completed" | "blocked"))
        }) {
            Some("coordination_pending")
        } else if !list(&work["budget"]["uncertainDispatches"]).is_empty()
            || values(&work["budget"]["attempts"])
                .iter()
                .any(|a| !list(&a["pendingTools"]).is_empty())
            || previous["failureKind"] == "execution_outcome_unknown"
        {
            Some("execution_unknown")
        } else if truth(&work["budget"]["unknownUsage"])
            || work["budget"]["unconfirmedUsd"]
                .as_f64()
                .is_some_and(|n| n > 0.0)
        {
            Some("budget_unconfirmed")
        } else if work["stopScope"] == "work" || previous_state == "paused" {
            Some("paused")
        } else if previous_state == "waiting_user" {
            Some("waiting_user")
        } else if list(&work["sessionIds"])
            .iter()
            .any(|s| !s.as_str().is_some_and(|s| facts.session_safe(s)))
        {
            Some("child_execution")
        } else if !matches!(
            previous_state.as_str(),
            Some("runnable" | "retry_wait" | "blocked_system" | "waiting_children")
        ) {
            Some("checkpoint_unavailable")
        } else {
            checkpoint_reason(work, previous, facts)?
        };
        out.push(json!({"workId":work["workId"],"workHash":sorted_digest(work)?,"disposition":if reason.is_some(){"held"}else{"resume"},"reason":reason.unwrap_or("checkpoint_verified")}));
    }
    Ok(out)
}
fn checkpoint_reason(
    work: &Value,
    previous: &Value,
    facts: &impl HistoryRecoveryFacts,
) -> Result<Option<&'static str>, &'static str> {
    let id = work["workId"]
        .as_str()
        .ok_or("coordination_recovery_identity_conflict")?;
    let checkpoint = match facts.checkpoint(id, work["checkpointRef"].as_str()) {
        Ok(Some(value)) => value,
        Ok(None) => Value::Null,
        Err(_) => return Ok(Some("checkpoint_unavailable")),
    };
    if peer_protocol::javascript_json_string(&checkpoint).is_err() {
        return Ok(Some("checkpoint_unavailable"));
    }
    let mut inputs: Vec<_> = list(&checkpoint["job"]["userInputs"])
        .iter()
        .map(|r| r["inputId"].clone())
        .collect();
    let mut anchors = list(&work["anchorInputIds"]).to_vec();
    let sort = |a: &Value, b: &Value| {
        a.as_str()
            .unwrap_or("")
            .encode_utf16()
            .cmp(b.as_str().unwrap_or("").encode_utf16())
    };
    inputs.sort_by(sort);
    anchors.sort_by(sort);
    if sorted_digest(&json!(inputs))? != sorted_digest(&json!(anchors))? {
        return Ok(Some("input_ownership"));
    }
    let calls: Vec<_> = list(&checkpoint["outcome"]["rounds"])
        .iter()
        .flat_map(|r| list(&r["toolCalls"]))
        .collect();
    if calls.iter().any(|c| {
        c["result"].is_null()
            || [&c["terminalReason"], &c["result"]["error"]]
                .into_iter()
                .any(|v| v.as_str().is_some_and(|s| s.ends_with("outcome_unknown")))
    }) {
        return Ok(Some("execution_unknown"));
    }
    if checkpoint["job"]["workId"] != work["workId"] {
        return Ok(Some("checkpoint_unavailable"));
    }
    if !calls.is_empty()
        || work["budget"]["toolCalls"]
            .as_f64()
            .is_some_and(|n| n > 0.0)
    {
        let native = if let Some(reference) = work["nativeCheckpointRef"].as_str() {
            facts.checkpoint(id, Some(reference)).ok().flatten()
        } else {
            checkpoint["outcome"].get("providerCheckpoint").cloned()
        };
        if !native.as_ref().is_some_and(Value::is_object) {
            return Ok(Some("checkpoint_unavailable"));
        }
    }
    if truth(&checkpoint["outcome"]["failed"]) && previous["retryable"] != true
        || truth(&checkpoint["outcome"]["stopped"])
        || work["stopScope"] == "reply"
    {
        return Ok(Some("paused"));
    }
    Ok(None)
}
