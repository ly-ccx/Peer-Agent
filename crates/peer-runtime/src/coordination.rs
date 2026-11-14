//! Canonical work/event/delivery semantics from work-coordination.mjs. Control
//! delegates to the existing native kernel. Unported kernels fail explicitly.
use peer_protocol::{CoordinationReducer, javascript_json_string};
use serde_json::{Value, json};
pub struct NativeCoordinationReducer;
fn error() -> &'static str {
    "coordination_event_invalid"
}
fn id(v: &Value) -> Result<&str, &'static str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or_else(error)
}
fn object(v: &Value) -> bool {
    v.is_object()
}
fn array(v: &Value) -> Result<&Vec<Value>, &'static str> {
    v.as_array().ok_or_else(error)
}
fn bucket<'a>(
    s: &'a mut Value,
    name: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, &'static str> {
    if s.get(name).is_none() {
        s[name] = json!({})
    }
    s[name].as_object_mut().ok_or_else(error)
}
fn put(s: &mut Value, name: &str, key: &str, value: Value) -> Result<(), &'static str> {
    bucket(s, name)?.insert(key.to_owned(), value);
    Ok(())
}
fn unique(values: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut out = Vec::new();
    for v in values {
        if !out.contains(&v) {
            out.push(v)
        }
    }
    out
}
fn apply_delta(previous: &Value, event: &Value) -> Result<Value, &'static str> {
    let work_id = id(&event["workId"])?;
    let patch = event["work"]
        .as_object()
        .ok_or("coordination_work_update_invalid")?;
    if patch.get("workId").is_some_and(|v| v != work_id)
        || patch.keys().any(|k| {
            [
                "__proto__",
                "constructor",
                "prototype",
                "budget",
                "progressFacts",
            ]
            .contains(&k.as_str())
        })
    {
        return Err("coordination_work_update_invalid");
    }
    let mut next = if previous.is_null() {
        json!({})
    } else {
        previous.clone()
    };
    let dest = next.as_object_mut().ok_or_else(error)?;
    for (k, v) in patch {
        dest.insert(k.clone(), v.clone());
    }
    dest.insert("workId".into(), json!(work_id));
    if let Some(removed) = event.get("removed") {
        for field in array(removed)? {
            dest.remove(id(field)?);
        }
    }
    if let Some(budget) = event.get("budget") {
        if !budget.is_object() {
            return Err(error());
        }
        next["budget"] = budget.clone();
        if let Some(v) = previous["budget"].get("observations") {
            next["budget"]["observations"] = v.clone()
        }
    }
    if let Some(observations) = event.get("observations") {
        for key in array(observations)? {
            if next.get("budget").is_none() {
                next["budget"] = json!({})
            }
            if next["budget"].get("observations").is_none() {
                next["budget"]["observations"] = json!({})
            }
            next["budget"]["observations"]
                .as_object_mut()
                .ok_or_else(error)?
                .insert(id(key)?.to_owned(), json!(true));
        }
    }
    if let Some(progress) = event.get("progress") {
        let removed = array(&progress["remove"])?;
        let added = array(&progress["add"])?;
        let old = previous["progressFacts"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        next["progressFacts"] = json!(unique(
            old.iter()
                .filter(|v| !removed.contains(v))
                .chain(added)
                .cloned()
        ));
    }
    Ok(next)
}
impl CoordinationReducer for NativeCoordinationReducer {
    fn reduce(&self, state: &Value, entry: &Value) -> Result<Value, &'static str> {
        // Bound before cloning, including source object keys and future fields.
        javascript_json_string(state).map_err(|_| "coordination_state_limit")?;
        javascript_json_string(entry).map_err(|_| "coordination_record_too_large")?;
        if entry.get("schemaVersion").is_some_and(|v| *v != 1) {
            return Err("coordination_schema_unsupported");
        }
        let revision = state["revision"].as_u64().ok_or_else(error)?;
        if revision >= 9_007_199_254_740_991 || entry["revision"].as_u64() != Some(revision + 1) {
            return Err("coordination_revision_gap");
        }
        let mut next = state.clone();
        next["revision"] = json!(revision + 1);
        for name in ["events", "works", "deliveries"] {
            bucket(&mut next, name)?;
        }
        match id(&entry["kind"])? {
            "session_control" => {
                return crate::session_control::reduce_session_control(&next, entry)
                    .map_err(|e| e.code());
            }
            "work" => {
                let work = &entry["work"];
                put(&mut next, "works", id(&work["workId"])?, work.clone())?;
            }
            "work_updated" => {
                let work_id = id(&entry["workId"])?;
                let work = apply_delta(&next["works"][work_id], entry)?;
                put(&mut next, "works", work_id, work)?;
            }
            "transfer" => {
                for event in array(&entry["events"])? {
                    let key = id(&event["eventId"])?;
                    if next["events"].get(key).is_none() {
                        put(
                            &mut next,
                            "events",
                            key,
                            json!({"event":event,"handled":false}),
                        )?;
                    }
                }
            }
            "handled" => {
                for key in array(&entry["eventIds"])? {
                    let key = id(key)?;
                    let row = next["events"].get_mut(key).ok_or("event_not_transferred")?;
                    row["handled"] = json!(true)
                }
            }
            "usage_observed" => {
                let key = id(&entry["workId"])?;
                let observation =
                    id(&entry["observationId"]).map_err(|_| "coordination_usage_invalid")?;
                let budget = next["works"][key]
                    .get_mut("budget")
                    .filter(|v| v.is_object())
                    .ok_or("coordination_usage_invalid")?;
                if budget["observations"].get(observation).is_none() {
                    if budget.get("observations").is_none() {
                        budget["observations"] = json!({})
                    }
                    budget["observations"][observation] = json!(true);
                    for (field, unknown) in [("tokens", "unknownUsage"), ("costUsd", "unknownCost")]
                    {
                        if let Some(n) =
                            entry[field].as_f64().filter(|n| n.is_finite() && *n >= 0.0)
                        {
                            let sum = budget[field].as_f64().unwrap_or(0.0) + n;
                            if !sum.is_finite() {
                                return Err("coordination_state_limit");
                            }
                            budget[field] = json!(sum)
                        } else {
                            budget[unknown] = json!(true)
                        }
                    }
                }
            }
            "continuations_coalesced" => {
                let owner = &entry["owner"];
                let owner_id = id(&owner["workId"]).map_err(|_| "invalid_continuation_custody")?;
                let retired =
                    array(&entry["retired"]).map_err(|_| "invalid_continuation_custody")?;
                if retired.iter().any(|w| {
                    w["state"] != "coalesced"
                        || w["continuationOwnerWorkId"] != owner_id
                        || w["workId"] == owner_id
                }) {
                    return Err("invalid_continuation_custody");
                }
                for work in std::iter::once(owner).chain(retired) {
                    put(&mut next, "works", id(&work["workId"])?, work.clone())?;
                }
            }
            "reply_deferred" | "reply_prepared" => {
                let key = id(&entry["message"]["id"])?;
                if next["deliveries"].get(key).is_none() {
                    if entry["message"]["question"].get("agentRequestId").is_some() {
                        return Err("coordination_native_reducer_unsupported");
                    }
                    put(
                        &mut next,
                        "deliveries",
                        key,
                        json!({"message":entry["message"],"state":if entry["kind"]=="reply_deferred"{"deferred"}else{"prepared"}}),
                    )?;
                }
            }
            "reply_held" => {
                let key = id(&entry["messageId"])?;
                let row = next["deliveries"]
                    .get_mut(key)
                    .filter(|v| v["state"] == "deferred")
                    .ok_or("coordination_delivery_conflict")?;
                row["heldAt"] = entry["at"].clone();
            }
            "reply_aggregated" => {
                let key = id(&entry["messageId"])?;
                let aggregate_id = id(&entry["aggregateId"])?;
                let delivery = &next["deliveries"][key];
                let aggregate = &next["deliveries"][aggregate_id];
                if delivery["state"] != "deferred"
                    || aggregate["state"] != "delivered"
                    || !aggregate["message"]["meta"]["digestReplyIds"]
                        .as_array()
                        .is_some_and(|v| v.contains(&json!(key)))
                    || !aggregate["message"]["content"].as_str().is_some_and(|c| {
                        delivery["message"]["content"]
                            .as_str()
                            .is_some_and(|d| c.contains(peer_protocol::javascript_trim(d)))
                    })
                {
                    return Err("coordination_aggregate_unproven");
                }
                next["deliveries"][key]["state"] = json!("aggregated");
                next["deliveries"][key]["deliveredBy"] = json!(aggregate_id);
            }
            "reply_delivered" => {
                let key = id(&entry["messageId"])?;
                let row = next["deliveries"]
                    .get_mut(key)
                    .ok_or("reply_not_prepared")?;
                if row.get("canonicalCommittedAt").is_some()
                    && row["settlement"]["status"] != "applied"
                {
                    return Err("coordination_delivery_unsettled");
                }
                row["state"] = json!("delivered");
            }
            "reply_committed"
            | "reply_settlement_started"
            | "reply_settlement_failed"
            | "reply_settled" => {
                let kind = entry["kind"].as_str().unwrap();
                let key = id(&entry["messageId"])?;
                let row = next["deliveries"]
                    .get_mut(key)
                    .filter(|v| v["state"] == "prepared")
                    .ok_or("coordination_delivery_conflict")?;
                if kind == "reply_committed" {
                    row["canonicalCommittedAt"] = entry["at"].clone();
                } else {
                    if kind != "reply_settlement_failed"
                        && row.get("canonicalCommittedAt").is_none()
                    {
                        return Err("coordination_delivery_uncommitted");
                    }
                    let attempts = row["settlement"]["attempts"].as_u64().unwrap_or(0);
                    let attempt = entry["attempt"]
                        .as_u64()
                        .ok_or("coordination_delivery_attempt_conflict")?;
                    if attempt != attempts + u64::from(kind == "reply_settlement_started") {
                        return Err("coordination_delivery_attempt_conflict");
                    }
                    let mut settlement = json!({"operationId":format!("settlement:{key}"),"attempts":attempt,"status":if kind=="reply_settled"{"applied"}else if kind=="reply_settlement_started"{"pending"}else{"failed"},"updatedAt":entry["at"]});
                    if kind == "reply_settlement_failed" {
                        for k in ["error", "phase", "retryAt"] {
                            if let Some(v) = entry.get(k) {
                                settlement[k] = v.clone()
                            }
                        }
                    }
                    row["settlement"] = settlement;
                }
            }
            "reply_invalidated" => {
                let key = id(&entry["messageId"])?;
                let row = next["deliveries"]
                    .get_mut(key)
                    .ok_or("reply_not_prepared")?;
                if row["message"]["question"].get("agentRequestId").is_some() {
                    return Err("coordination_native_reducer_unsupported");
                }
                row["state"] = json!("invalidated");
                row["reason"] = entry["reason"].clone();
            }
            "journal_recovered" => {
                let mut recovery = next
                    .get("lastRecovery")
                    .filter(|v| object(v))
                    .cloned()
                    .unwrap_or(json!({}));
                recovery["at"] = entry["at"].clone();
                recovery["backup"] = entry["backup"].clone();
                next["lastRecovery"] = recovery;
            }
            _ => return Err("coordination_native_reducer_unsupported"),
        }
        javascript_json_string(&next).map_err(|_| "coordination_state_limit")?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_ts_work_event_and_delivery_transitions_match() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/work-coordination.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let result = NativeCoordinationReducer.reduce(&case["previous"], &case["entry"]);
            if let Some(error) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), error, "{}", case["name"])
            } else {
                assert_eq!(
                    javascript_json_string(&result.unwrap()).unwrap(),
                    javascript_json_string(&case["expected"]).unwrap(),
                    "{}",
                    case["name"]
                );
            }
        }
    }
    #[test]
    fn unknown_semantics_and_bad_revision_do_not_become_an_empty_state() {
        let state =
            json!({"revision":1,"events":{},"works":{"kept":{"workId":"kept"}},"deliveries":{}});
        assert_eq!(
            NativeCoordinationReducer.reduce(
                &state,
                &json!({"schemaVersion":1,"revision":2,"kind":"history_resume_admitted"})
            ),
            Err("coordination_native_reducer_unsupported")
        );
        assert_eq!(
            NativeCoordinationReducer.reduce(
                &state,
                &json!({"schemaVersion":1,"revision":1,"kind":"work","work":{"workId":"new"}})
            ),
            Err("coordination_revision_gap")
        );
        assert!(state["works"].get("kept").is_some());
    }
}
