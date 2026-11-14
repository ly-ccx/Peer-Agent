//! Deterministic Session Control kernel. Inputs are admitted Host/journal facts;
//! this pure reducer cannot stop a process, issue permission or create Evidence.
use peer_protocol::{
    javascript_json_digest, javascript_json_string, normalize_session_execution_identity,
};
use serde_json::{Value, json};
use std::collections::HashSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlError {
    ExecutorUnsupported,
    Conflict,
    Superseded,
    WorkStopped,
    OutcomeRequired,
    ReceiptInvalid,
    ReceiptRequired,
    ResourceLimit,
}
impl ControlError {
    pub fn code(self) -> &'static str {
        match self {
            Self::ExecutorUnsupported => "session_control_executor_unsupported",
            Self::Conflict => "session_control_conflict",
            Self::Superseded => "session_control_superseded",
            Self::WorkStopped => "work_execution_stopped",
            Self::OutcomeRequired => "session_control_outcome_required",
            Self::ReceiptInvalid => "session_control_receipt_invalid",
            Self::ReceiptRequired => "session_control_receipt_required",
            Self::ResourceLimit => "session_control_resource_limit",
        }
    }
}

fn bounded(
    value: &Value,
    nodes: &mut usize,
    strings: &mut usize,
    depth: usize,
) -> Result<(), ControlError> {
    if depth > 64 || *nodes == 0 {
        return Err(ControlError::ResourceLimit);
    }
    *nodes -= 1;
    fn charge(strings: &mut usize, text: &str) -> Result<(), ControlError> {
        *strings = strings
            .checked_sub(text.len())
            .ok_or(ControlError::ResourceLimit)?;
        Ok(())
    }
    match value {
        Value::String(text) => charge(strings, text)?,
        Value::Array(items) => {
            for item in items {
                bounded(item, nodes, strings, depth + 1)?;
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                charge(strings, key)?;
                bounded(item, nodes, strings, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    }
}
fn integer(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n))
        .map(|n| n as u64)
}
fn timestamp(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| OffsetDateTime::parse(s, &Rfc3339).is_ok())
}
fn text(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !s.is_empty())
}
fn same_execution(a: &Value, b: &Value) -> bool {
    normalize_session_execution_identity(a)
        .is_some_and(|a| normalize_session_execution_identity(b).is_some_and(|b| a == b))
}
fn recorder_equal(a: &Value, b: &Value) -> Result<bool, ControlError> {
    let encode = |v| javascript_json_string(v).map_err(|_| ControlError::ResourceLimit);
    Ok(encode(a)? == encode(b)?)
}
fn valid_phase(phase: &str) -> bool {
    matches!(phase, "recorded" | "draining" | "reconciling" | "settled")
}
fn allowed_transition(from: &str, to: &str) -> bool {
    from == to
        || matches!(
            (from, to),
            ("recorded", "draining" | "settled")
                | ("draining", "reconciling" | "settled")
                | ("reconciling", "draining" | "settled")
        )
}

fn receipt_valid(receipt: &Value, operation: &Value) -> bool {
    let Some(claims) = receipt["resourceClaims"].as_array() else {
        return false;
    };
    let Some(unknown) = receipt["unknownCalls"].as_array() else {
        return false;
    };
    let mut ids = HashSet::new();
    receipt["operationId"] == operation["operationId"]
        && same_execution(&receipt["execution"], &operation["expectedExecution"])
        && ["admissionClosed", "runnerIdle", "schedulerIdle"]
            .into_iter()
            .all(|k| receipt[k] == true)
        && text(&receipt["receiptId"])
        && timestamp(&receipt["completedAt"])
        && receipt["scope"] == "managed_execution"
        && claims.iter().all(|r| {
            text(&r["claimId"])
                && integer(&r["revision"]).is_some_and(|n| n >= 1)
                && ids.insert(r["claimId"].as_str().unwrap())
        })
        && unknown.iter().all(text)
}

/// Returns a candidate state; failures leave the input state intact. The Store
/// must commit it under its real current revision/owner transaction, not cache it
/// as authority. A bounded relevant control projection keeps history on disk.
pub fn reduce_session_control(state: &Value, entry: &Value) -> Result<Value, ControlError> {
    bounded(state, &mut 32_768, &mut (4 * 1024 * 1024), 0)?;
    bounded(entry, &mut 8192, &mut (512 * 1024), 0)?;
    if let Some(version) = entry.get("minimumExecutorVersion")
        && !matches!(integer(version), Some(7 | 9))
    {
        return Err(ControlError::ExecutorUnsupported);
    }
    let operation = &entry["operation"];
    if !state.is_object() || !entry.is_object() || !operation.is_object() {
        return Err(ControlError::Conflict);
    }
    let kind = operation["kind"].as_str().ok_or(ControlError::Conflict)?;
    let phase = operation["phase"].as_str().ok_or(ControlError::Conflict)?;
    if !matches!(kind, "pause" | "cancel" | "takeover" | "resume")
        || !valid_phase(phase)
        || ![
            "operationId",
            "requestDigest",
            "workspaceId",
            "parentConversationId",
            "sessionId",
            "planId",
            "authorityRef",
            "updatedAt",
        ]
        .into_iter()
        .all(|k| text(&operation[k]))
        || !timestamp(&operation["updatedAt"])
        || operation
            .get("hostPid")
            .is_some_and(|pid| integer(pid).is_none_or(|n| n < 1))
    {
        return Err(ControlError::Conflict);
    }
    let execution = normalize_session_execution_identity(&operation["expectedExecution"])
        .ok_or(ControlError::Conflict)?;
    if Some(execution.plan_id.as_str()) != operation["planId"].as_str()
        || Some(execution.session_id.as_str()) != operation["sessionId"].as_str()
    {
        return Err(ControlError::Conflict);
    }
    let digest=javascript_json_digest(&json!({"kind":kind,"operationId":operation["operationId"],"authorityRef":operation["authorityRef"],"execution":operation["expectedExecution"]})).map_err(|_|ControlError::ResourceLimit)?;
    if operation["requestDigest"].as_str() != Some(digest.as_str()) {
        return Err(ControlError::Conflict);
    }
    let operation_id = operation["operationId"]
        .as_str()
        .ok_or(ControlError::Conflict)?;
    let session_id = operation["sessionId"]
        .as_str()
        .ok_or(ControlError::Conflict)?;
    let empty = serde_json::Map::new();
    let controls = match state.get("sessionControls") {
        Some(v) if v.is_object() => v.as_object().unwrap(),
        None => &empty,
        _ => return Err(ControlError::Conflict),
    };
    let heads = match state.get("sessionControlHeads") {
        Some(v) if v.is_object() => v.as_object().unwrap(),
        None => &empty,
        _ => return Err(ControlError::Conflict),
    };
    let old = match controls.get(operation_id) {
        Some(value) if value.is_object() => Some(value),
        Some(value) if truthy(value) => return Err(ControlError::Conflict),
        _ => None,
    };
    let old_revision = old
        .map(|v| integer(&v["revision"]).ok_or(ControlError::Conflict))
        .transpose()?
        .unwrap_or(0);
    if old_revision >= 9_007_199_254_740_991
        || integer(&operation["revision"]) != Some(old_revision + 1)
        || integer(&entry["expectedRevision"]) != Some(old_revision)
    {
        return Err(ControlError::Conflict);
    }
    let head = heads
        .get(session_id)
        .and_then(|v| v["operationId"].as_str())
        .filter(|s| !s.is_empty());
    if let Some(old) = old {
        if [
            "requestDigest",
            "workspaceId",
            "parentConversationId",
            "sessionId",
            "planId",
            "kind",
            "authorityRef",
            "hostEpoch",
            "hostPid",
            "unproven",
            "priorStopReceiptId",
        ]
        .into_iter()
        .any(|k| {
            if k == "hostPid" && old[k].is_number() && operation[k].is_number() {
                old[k].as_f64() != operation[k].as_f64()
            } else {
                old.get(k) != operation.get(k)
            }
        }) || !same_execution(&old["expectedExecution"], &operation["expectedExecution"])
            || !recorder_equal(&old["recorder"], &operation["recorder"])?
            || old["phase"] == "settled"
            || !old["phase"]
                .as_str()
                .is_some_and(|old| allowed_transition(old, phase))
        {
            return Err(ControlError::Conflict);
        }
        if head != Some(operation_id) {
            return Err(ControlError::Superseded);
        }
    } else {
        let expected_head = head.map(Value::from).unwrap_or(Value::Null);
        if phase != "recorded" || entry.get("expectedCurrentOperationId") != Some(&expected_head) {
            return Err(ControlError::Conflict);
        }
        if head
            .and_then(|id| controls.get(id))
            .is_some_and(|previous| previous["kind"] == "cancel")
            && kind != "cancel"
        {
            return Err(ControlError::WorkStopped);
        }
    }
    if phase == "settled"
        && !operation["outcome"]
            .as_str()
            .is_some_and(|s| matches!(s, "applied" | "superseded" | "rejected"))
    {
        return Err(ControlError::OutcomeRequired);
    }
    if let Some(receipt) = operation.get("stopReceipt").filter(|v| truthy(v))
        && !receipt_valid(receipt, operation)
    {
        return Err(ControlError::ReceiptInvalid);
    }
    if phase == "settled"
        && operation["outcome"] == "applied"
        && kind != "resume"
        && operation.get("stopReceipt").is_none_or(|r| !truthy(r))
    {
        return Err(ControlError::ReceiptRequired);
    }
    let mut next = state.clone();
    if next.get("sessionControls").is_none() {
        next["sessionControls"] = Value::Object(serde_json::Map::new());
    }
    if next.get("sessionControlHeads").is_none() {
        next["sessionControlHeads"] = Value::Object(serde_json::Map::new());
    }
    let controls = next["sessionControls"]
        .as_object_mut()
        .ok_or(ControlError::Conflict)?;
    if old.is_none()
        && let Some(previous_id) = head
        && let Some(previous) = controls
            .get_mut(previous_id)
            .filter(|v| v["phase"] != "settled")
    {
        let revision = integer(&previous["revision"])
            .filter(|n| *n < 9_007_199_254_740_991)
            .ok_or(ControlError::Conflict)?;
        previous["phase"] = "settled".into();
        previous["outcome"] = "superseded".into();
        previous["supersededBy"] = operation_id.into();
        previous["revision"] = (revision + 1).into();
        previous["updatedAt"] = operation["updatedAt"].clone();
    }
    controls.insert(operation_id.to_owned(), operation.clone());
    next["sessionControlHeads"][session_id] = json!({"operationId":operation_id});
    Ok(next)
}
