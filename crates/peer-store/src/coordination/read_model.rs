//! Same public snapshot as the existing SQL adapter, rebuilt from canonical
//! events. Projection never rewrites or discards unknown source journal fields.
use super::CoordinationError as Error;
use serde_json::{Value, json};
const BUCKETS: &[&str] = &[
    "sessionControls",
    "sessionControlHeads",
    "obligationDispositions",
    "obligationGrants",
    "obligationHeads",
    "obligationResults",
    "events",
    "works",
    "deliveries",
    "mandates",
    "decisions",
    "transitions",
    "inputBindings",
    "intentDecisions",
    "agentMessages",
    "agentRequests",
    "agentCommands",
    "workNotes",
    "contextWindows",
];
pub(super) fn project(state: &Value) -> Result<Value, Error> {
    let mut out = json!({"revision":state["revision"]});
    for name in BUCKETS {
        let rows = state.get(name).filter(|v| !v.is_null());
        if rows.is_some_and(|v| !v.is_object()) {
            return Err(Error::Corrupt);
        }
        if rows.is_some_and(|v| !v.as_object().unwrap().is_empty())
            || ["events", "works", "deliveries"].contains(name)
        {
            out[name] = rows.cloned().unwrap_or(json!({}));
        }
    }
    if let Some(works) = out["works"].as_object_mut() {
        for work in works.values_mut() {
            if let Some(observations) = work["budget"]["observations"].as_object() {
                let mut normalized = serde_json::Map::new();
                for key in observations.keys() {
                    normalized.insert(key.clone(), json!(true));
                }
                let budget = work
                    .get_mut("budget")
                    .and_then(Value::as_object_mut)
                    .ok_or(Error::Corrupt)?;
                if normalized.is_empty() {
                    budget.shift_remove("observations");
                } else {
                    budget.insert("observations".into(), Value::Object(normalized));
                }
            }
        }
    }
    if let Some(recovery) = state
        .get("lastRecovery")
        .filter(|v| !v.is_null() && **v != false)
    {
        out["lastRecovery"] = recovery.clone()
    }
    Ok(out)
}
