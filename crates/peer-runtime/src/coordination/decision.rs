//! Mandate and transition facts; this reducer does not grant capabilities.
use super::{
    bucket, id, put, unique,
    value::{contains, list, merge, num, remove, truth},
};
use serde_json::{Value, json};
const PHASES: &[(&str, &[&str])] = &[
    ("recorded", &["stopping", "ready", "completed", "blocked"]),
    (
        "stopping",
        &["awaiting_outcome", "ready", "completed", "blocked"],
    ),
    (
        "awaiting_outcome",
        &["stopping", "ready", "completed", "blocked"],
    ),
    ("ready", &["started", "completed", "blocked"]),
    ("started", &["completed", "blocked"]),
    ("blocked", &["stopping", "ready", "completed"]),
];
pub(super) fn reduce(mut next: Value, e: &Value) -> Result<Value, &'static str> {
    for b in ["mandates", "decisions", "transitions", "inputBindings"] {
        bucket(&mut next, b)?;
    }
    match e["kind"].as_str().unwrap_or("") {
        "coordination_decision" => {
            if e["transition"]["schemaVersion"] != 1
                || !matches!(num(&e["transition"]["minimumExecutorVersion"]), Some(1..=3))
            {
                return Err("coordination_executor_unsupported");
            }
            let mandate = &e["mandate"];
            let receipt = &e["receipt"];
            let work = id(&mandate["workId"])?;
            let op = id(&receipt["operationId"])?;
            if num(&next["mandates"][work]["goalRevision"]).unwrap_or(0)
                != num(&receipt["expectedRevision"]).ok_or("goal_revision_conflict")?
                || next["decisions"].get(op).is_some()
            {
                return Err("goal_revision_conflict");
            }
            put(&mut next, "mandates", work, mandate.clone())?;
            put(&mut next, "decisions", op, receipt.clone())?;
            put(&mut next, "transitions", op, e["transition"].clone())?;
            for input in super::array(&receipt["sourceInputIds"])? {
                let key = id(input)?;
                let refs = unique(
                    list(&next["inputBindings"][key])
                        .iter()
                        .cloned()
                        .chain(std::iter::once(json!(op))),
                );
                put(&mut next, "inputBindings", key, json!(refs))?;
            }
        }
        "coordination_binding" => {
            let key = id(&e["workId"])?;
            let old = &next["mandates"][key];
            if old.is_null()
                || old["goalRevision"] != e["goalRevision"]
                || old["lifecycle"] != "active"
            {
                return Err("goal_revision_conflict");
            }
            let mut row = old.clone();
            row["sessionIds"] = json!(unique(
                list(&old["sessionIds"])
                    .iter()
                    .cloned()
                    .chain(std::iter::once(e["sessionId"].clone()))
            ));
            row["revokedSessionIds"] = json!(
                list(&old["revokedSessionIds"])
                    .iter()
                    .filter(|v| **v != e["sessionId"])
                    .collect::<Vec<_>>()
            );
            let mut bindings = if old["executionBindings"].is_object() {
                old["executionBindings"].clone()
            } else {
                json!({})
            };
            if truth(&e["binding"]) {
                bindings[id(&e["sessionId"])?] = e["binding"].clone()
            }
            row["executionBindings"] = bindings;
            put(&mut next, "mandates", key, row)?;
        }
        "coordination_transition" => {
            let key = id(&e["operationId"])?;
            let old = &next["transitions"][key];
            let patch = &e["patch"];
            if old.is_null() || old["phase"] != e["expectedPhase"] {
                return Err("transition_phase_conflict");
            }
            if let Some(phase) = patch.get("phase")
                && phase != &old["phase"]
                && !PHASES.iter().any(|(from, to)| {
                    old["phase"] == *from && phase.as_str().is_some_and(|p| to.contains(&p))
                })
            {
                return Err("invalid_transition_phase");
            }
            if patch["phase"] == "completed"
                && old["phase"] == "blocked"
                && !truth(&patch["controlOperationRef"])
            {
                return Err("control_receipt_required");
            }
            if truth(&patch["controlOperationRef"]) {
                let control = &next["sessionControls"][id(&patch["controlOperationRef"])?];
                if control.is_null()
                    || control["kind"] != "cancel"
                    || control["sessionId"] != old["oldSessionId"]
                    || !truth(&control["stopReceipt"])
                {
                    return Err("control_receipt_required");
                }
            }
            if patch
                .get("executionAdmission")
                .is_some_and(|v| !contains(&json!(["queued", "admitted", "rejected"]), v))
                || patch.get("executionEffect").is_some_and(|v| {
                    !contains(&json!(["pending", "applied", "unknown", "rejected"]), v)
                })
            {
                return Err("invalid_execution_receipt");
            }
            let admission = if truth(&patch["executionAdmission"]) {
                &patch["executionAdmission"]
            } else {
                &old["executionAdmission"]
            };
            if patch["executionEffect"] == "applied"
                && (!truth(&patch["executionAttemptRef"]) || admission != "admitted")
            {
                return Err("execution_receipt_unproven");
            }
            let mut patch = patch.clone();
            if old["executionEffect"] == "applied" {
                remove(&mut patch, "executionEffect");
                remove(&mut patch, "executionAdmission");
            }
            let row = merge(old, &patch);
            put(&mut next, "transitions", key, row)?;
        }
        _ => return Err("unknown_coordination_event"),
    }
    Ok(next)
}
