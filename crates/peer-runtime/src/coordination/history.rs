//! Cold history reconciliation preserves old effects and quarantine identities.
use super::{
    bucket, id, put, unique,
    value::{contains, list, merge, num, remove, sorted_digest, truth},
};
use serde_json::{Value, json};
fn terminal(w: &Value) -> bool {
    ["delivered", "cancelled", "coalesced"].contains(&w["state"].as_str().unwrap_or(""))
}
fn held(w: &Value) -> bool {
    w["historyRecovery"]["disposition"] == "held"
}
fn unsettled(w: &Value) -> bool {
    !list(&w["budget"]["uncertainDispatches"]).is_empty()
        || w["budget"]["attempts"]
            .as_object()
            .is_some_and(|m| m.values().any(|a| !list(&a["pendingTools"]).is_empty()))
}
fn union(a: &Value, b: &Value) -> Vec<Value> {
    unique(list(a).iter().chain(list(b)).cloned())
}
pub(super) fn reduce(previous: &Value, e: &Value) -> Result<Value, &'static str> {
    let bad = "coordination_resume_plan_changed";
    let mut next = previous.clone();
    match e["kind"].as_str().unwrap_or("") {
        "history_reconciled" => {
            let fp = e["recovery"]["sourceFingerprint"].as_str().unwrap_or("");
            if previous["revision"] != 0
                || e["revision"] != 1
                || e["state"]["revision"] != 0
                || e["recovery"]["executionBlocked"] != true
                || fp.len() != 64
                || !fp
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || e["stateHash"].as_str() != Some(&sorted_digest(&e["state"])?)
                || !["events", "works", "deliveries"]
                    .iter()
                    .all(|k| e["state"][k].is_object())
            {
                return Err("coordination_repair_state_invalid");
            }
            next = e["state"].clone();
            next["lastRecovery"] = merge(&e["recovery"], &json!({"at":e["at"]}));
        }
        "history_resume_admitted" => {
            let recovery = &previous["lastRecovery"];
            let fp = e["sourceFingerprint"].as_str().unwrap_or("");
            if recovery.is_null()
                || fp.len() != 64
                || !fp
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || e["sourceFingerprint"] != recovery["sourceFingerprint"]
                || e["expectedRevision"] != previous["revision"]
                || !e["decisions"].is_array()
                || [
                    "quarantinedSessionIds",
                    "quarantinedInputIds",
                    "quarantinedEventIds",
                ]
                .iter()
                .any(|k| e.get(k).is_some_and(|v| !v.is_array()))
            {
                return Err(bad);
            }
            let initial = recovery["executionBlocked"] != false;
            previous["works"].as_object().ok_or(bad)?;
            let ids: Vec<_> = super::value::values(&previous["works"])
                .into_iter()
                .filter(|w| !terminal(w) && (initial || held(w)))
                .map(|w| w["workId"].clone())
                .collect();
            let decisions = list(&e["decisions"]);
            if decisions.len() != ids.len()
                || unique(decisions.iter().map(|r| r["workId"].clone())).len() != ids.len()
            {
                return Err(bad);
            }
            let holding: Vec<_> = decisions
                .iter()
                .filter(|r| r["disposition"] == "held")
                .map(|r| r["workId"].clone())
                .collect();
            let mut sessions = union(
                &recovery["quarantinedSessionIds"],
                &e["quarantinedSessionIds"],
            );
            let operations = unique(
                list(&recovery["quarantinedOperationIds"])
                    .iter()
                    .cloned()
                    .chain(
                        super::value::values(&previous["transitions"])
                            .into_iter()
                            .filter(|r| {
                                (initial || holding.contains(&r["workId"]))
                                    && !["completed", "blocked"]
                                        .contains(&r["phase"].as_str().unwrap_or(""))
                            })
                            .map(|r| r["operationId"].clone()),
                    ),
            );
            let inputs = union(&recovery["quarantinedInputIds"], &e["quarantinedInputIds"]);
            let events = union(&recovery["quarantinedEventIds"], &e["quarantinedEventIds"]);
            let deliveries = unique(
                list(&recovery["quarantinedDeliveryIds"])
                    .iter()
                    .cloned()
                    .chain(
                        super::value::values(&previous["deliveries"])
                            .into_iter()
                            .filter(|r| {
                                (initial || holding.contains(&r["message"]["meta"]["workId"]))
                                    && r["state"] == "prepared"
                            })
                            .map(|r| r["message"]["id"].clone()),
                    ),
            );
            if inputs.iter().chain(&sessions).any(|v| {
                !v.as_str()
                    .is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
            }) || events
                .iter()
                .any(|v| !v.as_str().is_some_and(|s| !s.is_empty()))
            {
                return Err(bad);
            }
            let mut held_ids = Vec::new();
            let mut resumed = list(&recovery["resumedWorkIds"]).to_vec();
            for row in decisions {
                let key = id(&row["workId"]).map_err(|_| bad)?;
                let work = &previous["works"][key];
                if !ids.contains(&row["workId"])
                    || row["workHash"].as_str() != Some(&sorted_digest(work)?)
                    || !["held", "resume"].contains(&row["disposition"].as_str().unwrap_or(""))
                {
                    return Err(bad);
                }
                if row["disposition"] == "resume"
                    && (!truth(&work["checkpointRef"])
                        || row["reason"] != "checkpoint_verified"
                        || unsettled(work))
                {
                    return Err(bad);
                }
                let previous_state = work["historyRecovery"]
                    .get("previousState")
                    .filter(|v| !v.is_null())
                    .unwrap_or(&work["state"]);
                let previous_recovery = work["historyRecovery"]
                    .get("previousRecovery")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(Value::Null);
                let hr = json!({"sourceFingerprint":e["sourceFingerprint"],"disposition":row["disposition"],"reason":row["reason"],"previousState":previous_state,"previousRecovery":previous_recovery,"at":e["at"]});
                let mut updated = merge(
                    work,
                    &json!({"state":if row["disposition"]=="held"{"blocked_system"}else{"runnable"},"revision":num(&work["revision"]).unwrap_or(0)+1,"historyRecovery":hr}),
                );
                if row["disposition"] == "held" {
                    held_ids.push(row["workId"].clone());
                    sessions = unique(
                        sessions
                            .into_iter()
                            .chain(list(&work["sessionIds"]).iter().cloned()),
                    );
                    let mut r = merge(
                        &work["recovery"],
                        &json!({"retryable":false,"blockedCode":"COORDINATION_RECONCILIATION_REQUIRED"}),
                    );
                    remove(&mut r, "retryAt");
                    remove(&mut r, "reservationId");
                    updated["recovery"] = r;
                } else {
                    resumed.push(row["workId"].clone());
                    if previous_recovery.is_null() {
                        remove(&mut updated, "recovery")
                    } else {
                        updated["recovery"] = previous_recovery
                    }
                }
                put(&mut next, "works", key, updated)?;
            }
            next["lastRecovery"] = merge(
                recovery,
                &json!({"executionBlocked":false,"heldWorkIds":held_ids,"resumedWorkIds":unique(resumed),"quarantinedSessionIds":sessions,"quarantinedOperationIds":operations,"quarantinedInputIds":inputs,"quarantinedEventIds":events,"quarantinedDeliveryIds":deliveries,"admittedAt":e["at"]}),
            );
        }
        "history_work_retained" => {
            let key = id(&e["workId"]).map_err(|_| bad)?;
            let work = &previous["works"][key];
            let recovery = &previous["lastRecovery"];
            if !held(work)
                || e["workHash"].as_str() != Some(&sorted_digest(work)?)
                || e["expectedRevision"] != previous["revision"]
                || e.get("sourceFingerprint") != recovery.get("sourceFingerprint")
            {
                return Err(bad);
            }
            let updated = merge(
                work,
                &json!({"state":"cancelled","end":"cancelled","stopScope":"work","revision":num(&work["revision"]).unwrap_or(0)+1,"historyRecovery":merge(&work["historyRecovery"],&json!({"disposition":"retained","at":e["at"]}))}),
            );
            put(&mut next, "works", key, updated)?;
            next["lastRecovery"] = merge(
                recovery,
                &json!({"heldWorkIds":list(&recovery["heldWorkIds"]).iter().filter(|v|**v!=e["workId"]).collect::<Vec<_>>(),"retainedSessionIds":union(&recovery["retainedSessionIds"],&work["sessionIds"])}),
            );
        }
        "history_session_retained" => {
            let recovery = &previous["lastRecovery"];
            if e["expectedRevision"] != previous["revision"]
                || e.get("sourceFingerprint") != recovery.get("sourceFingerprint")
                || !contains(&recovery["quarantinedSessionIds"], &e["sessionId"])
            {
                return Err(bad);
            }
            next["lastRecovery"] = merge(
                recovery,
                &json!({"retainedSessionIds":unique(list(&recovery["retainedSessionIds"]).iter().cloned().chain(std::iter::once(e["sessionId"].clone())))}),
            );
        }
        _ => return Err("unknown_coordination_event"),
    }
    bucket(&mut next, "works")?;
    next["revision"] = e["revision"].clone();
    Ok(next)
}
