//! Intent coverage/review/delivery are canonical facts, never permissions.
use super::{
    bucket, id, put,
    value::{allowed, digest_matches, list, merge, num, text, truth},
};
use serde_json::{Value, json};
fn ids(v: &Value, max: usize) -> bool {
    v.as_array().is_some_and(|a| {
        a.len() <= max
            && a.iter().all(|s| text(s, 200))
            && super::unique(a.clone()).len() == a.len()
    })
}
fn strings(v: &Value) -> bool {
    v.as_array()
        .is_some_and(|a| a.len() <= 16 && a.iter().all(|s| text(s, 500)))
}
fn unique_field(v: &Value, key: &str) -> bool {
    super::unique(list(v).iter().map(|r| r[key].clone())).len() == list(v).len()
}
pub(super) fn interpretation(v: &Value) -> bool {
    allowed(
        v,
        &[
            "outcome",
            "constraints",
            "nonGoals",
            "openQuestions",
            "requirements",
        ],
    ) && text(&v["outcome"], 4000)
        && strings(&v["constraints"])
        && strings(&v["nonGoals"])
        && strings(&v["openQuestions"])
        && v["requirements"].as_array().is_some_and(|a| {
            !a.is_empty()
                && a.len() <= 32
                && unique_field(&v["requirements"], "requirementId")
                && a.iter().all(|r| {
                    allowed(r, &["requirementId", "text", "sourceInputIds"])
                        && text(&r["requirementId"], 200)
                        && text(&r["text"], 1000)
                        && ids(&r["sourceInputIds"], 64)
                        && !list(&r["sourceInputIds"]).is_empty()
                })
        })
}
fn disposition(v: &Value) -> bool {
    match v["kind"].as_str().unwrap_or("") {
        "continue" => {
            allowed(v, &["kind", "operationRefs"])
                && ids(&v["operationRefs"], 64)
                && !list(&v["operationRefs"]).is_empty()
        }
        "wait" => {
            allowed(v, &["kind", "waitFor"])
                && v["waitFor"].as_array().is_some_and(|a| {
                    !a.is_empty()
                        && a.len() <= 32
                        && a.iter().all(|r| {
                            allowed(r, &["kind", "id", "revision"])
                                && ["session", "human_request", "resource", "recovery"]
                                    .contains(&r["kind"].as_str().unwrap_or(""))
                                && text(&r["id"], 200)
                                && text(&r["revision"], 200)
                        })
                })
        }
        "return" => allowed(v, &["kind", "replyRef"]) && text(&v["replyRef"], 200),
        "withdraw" => allowed(v, &["kind", "controlRef"]) && text(&v["controlRef"], 200),
        "blocked_system" => {
            allowed(v, &["kind", "code", "recoveryRef"])
                && text(&v["code"], 200)
                && text(&v["recoveryRef"], 200)
        }
        _ => false,
    }
}
pub(super) fn assessment(v: &Value) -> bool {
    allowed(
        v,
        &[
            "operationId",
            "workId",
            "expectedWorkRevision",
            "expectedGoalRevision",
            "sourceInputIds",
            "sourceEventIds",
            "sourceDecisionRef",
            "inputs",
            "interpretation",
            "coverage",
            "disposition",
            "reason",
        ],
    ) && text(&v["operationId"], 200)
        && text(&v["workId"], 200)
        && num(&v["expectedWorkRevision"]).is_some()
        && num(&v["expectedGoalRevision"]).is_some()
        && ids(&v["sourceInputIds"], 64)
        && ids(&v["sourceEventIds"], 64)
        && v.get("sourceDecisionRef").is_none_or(|s| text(s, 200))
        && v["inputs"].as_array().is_some_and(|a| {
            a.len() <= 64
                && unique_field(&v["inputs"], "inputId")
                && a.iter().all(|r| {
                    allowed(r, &["inputId", "kind", "reason"])
                        && text(&r["inputId"], 200)
                        && [
                            "discuss", "answer", "delegate", "augment", "revise", "withdraw",
                        ]
                        .contains(&r["kind"].as_str().unwrap_or(""))
                        && text(&r["reason"], 500)
                })
        })
        && v.get("interpretation").is_none_or(interpretation)
        && v["coverage"].as_array().is_some_and(|a| {
            a.len() <= 32
                && unique_field(&v["coverage"], "requirementId")
                && a.iter().all(|r| {
                    allowed(r, &["requirementId", "status", "explanation", "sources"])
                        && text(&r["requirementId"], 200)
                        && ["remaining", "covered", "uncertain"]
                            .contains(&r["status"].as_str().unwrap_or(""))
                        && text(&r["explanation"], 1000)
                        && r["sources"].as_array().is_some_and(|s| {
                            s.len() <= 32
                                && s.iter().all(|s| {
                                    allowed(s, &["sessionId", "sourceRevision", "evidenceRefs"])
                                        && text(&s["sessionId"], 200)
                                        && text(&s["sourceRevision"], 200)
                                        && ids(&s["evidenceRefs"], 64)
                                })
                        })
                        && (r["status"] != "covered"
                            || !list(&r["sources"]).is_empty()
                                && list(&r["sources"])
                                    .iter()
                                    .all(|s| !list(&s["evidenceRefs"]).is_empty()))
                })
        })
        && disposition(&v["disposition"])
        && text(&v["reason"], 1000)
        && peer_protocol::javascript_json_string(v).is_ok_and(|s| s.encode_utf16().count() <= 64000)
}
fn current_reply(message: &Value, work: &Value) -> bool {
    let intent = &work["intentCoordination"];
    list(&message["meta"]["intentBindings"]).iter().any(|b| {
        b["workId"] == work["workId"]
            && b["goalRevision"] == intent["goalRevision"]
            && b["intentRevision"] == intent["revision"]
            && b["decisionRef"] == intent["decision"]["operationId"]
            && (if truth(&b["replyRef"]) {
                &b["replyRef"]
            } else {
                &message["id"]
            }) == &intent["decision"]["disposition"]["replyRef"]
    })
}
fn candidate(row: &Value, work: &Value) -> bool {
    let intent = &work["intentCoordination"];
    row["state"] == "delivered"
        && row["message"]["content"]
            .as_str()
            .is_some_and(|s| !peer_protocol::javascript_trim(s).is_empty())
        && (current_reply(&row["message"], work)
            || list(&intent["decision"]["sourceInputIds"]).is_empty()
                && list(&row["message"]["meta"]["intentScopes"])
                    .iter()
                    .any(|s| {
                        s["workId"] == work["workId"] && s["goalRevision"] == intent["goalRevision"]
                    }))
}
fn source_in_message(source: &Value, message: &Value) -> bool {
    list(&message["meta"]["sessionStates"]).iter().any(|s| {
        s.get("sessionId") == source.get("sessionId")
            && s.get("sourceRevision") == source.get("sourceRevision")
            && ["result_ready", "accepted"].contains(&s["status"].as_str().unwrap_or(""))
    })
}
pub(super) fn delivered_reply_refs(
    state: &Value,
    work: &Value,
    restrict: Option<&[Value]>,
) -> Vec<Value> {
    let candidates: Vec<_> = super::value::values(&state["deliveries"])
        .into_iter()
        .filter(|r| {
            candidate(r, work) && restrict.is_none_or(|ids| ids.contains(&r["message"]["id"]))
        })
        .collect();
    let coverage_sources: Vec<_> = list(&work["intentCoordination"]["coverage"])
        .iter()
        .flat_map(|r| list(&r["sources"]))
        .collect();
    let sources: Vec<_> = work["intentCoordination"]["review"]
        .get("sources")
        .filter(|v| truth(v))
        .map(|v| list(v).iter().collect())
        .unwrap_or(coverage_sources);
    if let Some(direct) = candidates.iter().find(|r| {
        current_reply(&r["message"], work)
            && sources.iter().any(|s| source_in_message(s, &r["message"]))
    }) {
        return vec![direct["message"]["id"].clone()];
    }
    if sources.is_empty() {
        return Vec::new();
    }
    let mut selected = Vec::new();
    for source in sources {
        let Some(row) = candidates
            .iter()
            .find(|r| source_in_message(source, &r["message"]))
        else {
            return Vec::new();
        };
        selected.push(row["message"]["id"].clone());
    }
    super::unique(selected)
}
fn prove_delivery(state: &Value, work: &Value, refs: &Value) -> bool {
    let refs = list(refs);
    !refs.is_empty()
        && refs.iter().all(|id| {
            id.as_str()
                .is_some_and(|id| candidate(&state["deliveries"][id], work))
        })
        && !delivered_reply_refs(state, work, Some(refs)).is_empty()
}
pub(super) fn reduce(mut next: Value, e: &Value) -> Result<Value, &'static str> {
    if !matches!(num(&e["minimumExecutorVersion"]), Some(8 | 9)) {
        return Err("intent_executor_unsupported");
    }
    let work_id = id(&e["workId"])?;
    let work = next["works"][work_id].clone();
    if work.is_null() {
        return Err("intent_work_missing");
    }
    let prior = &work["intentCoordination"];
    match e["kind"].as_str().unwrap_or("") {
        "intent_reviewed" => {
            let review = &e["review"];
            if prior.is_null()
                || prior["lifecycle"] != "active"
                || review["goalRevision"] != prior["goalRevision"]
                || review["intentRevision"] != prior["revision"]
                || !text(&review["reviewRef"], 200)
                || !digest_matches(&review["coverageDigest"], &prior["coverage"])
                || !review["passed"].is_boolean()
                || !review["sources"].is_array()
                || !ids(&review["evidenceRefs"], 200)
                || !text(&review["at"], 100)
            {
                return Err("intent_review_conflict");
            }
            next["works"][work_id]["intentCoordination"]["review"] = review.clone();
        }
        "intent_closed" => {
            let r = &e["receipt"];
            let goal = num(&next["mandates"][work_id]["goalRevision"]).unwrap_or(0);
            if prior.is_null()
                || prior["lifecycle"] != "active"
                || r["workId"] != work["workId"]
                || num(&r["workRevision"]) != num(&prior["revision"]).and_then(|n| n.checked_add(1))
                || r["goalRevision"] != prior["goalRevision"]
                || num(&r["goalRevision"]) != Some(goal)
                || !["fulfilled", "cancelled"].contains(&r["lifecycle"].as_str().unwrap_or(""))
                || !text(&r["at"], 100)
                || !text(&r["operationId"], 200)
                || next["intentDecisions"]
                    .get(id(&r["operationId"])?)
                    .is_some()
            {
                return Err("intent_closure_conflict");
            }
            if r["lifecycle"] == "fulfilled" {
                let reply_ref = if truth(&r["intentReplyRef"]) {
                    &r["intentReplyRef"]
                } else {
                    &r["replyRef"]
                };
                let fallback = json!([r["replyRef"]]);
                let refs = if truth(&r["replyRefs"]) {
                    &r["replyRefs"]
                } else {
                    &fallback
                };
                if prior["decision"]["disposition"]["kind"] != "return"
                    || &prior["decision"]["disposition"]["replyRef"] != reply_ref
                    || !prove_delivery(&next, &work, refs)
                    || prior["review"]["passed"] != true
                    || prior["review"]["reviewRef"] != r["reviewRef"]
                    || prior["review"]["goalRevision"] != prior["goalRevision"]
                    || prior["review"]["intentRevision"] != prior["revision"]
                    || !prior["coverage"].is_array()
                    || list(&prior["coverage"])
                        .iter()
                        .any(|r| r["status"] != "covered")
                    || !prior["interpretation"]["openQuestions"].is_array()
                    || !list(&prior["interpretation"]["openQuestions"]).is_empty()
                {
                    return Err("intent_closure_unproven");
                }
            } else {
                let control = &next["transitions"]
                    [id(&r["controlRef"]).map_err(|_| "intent_control_unproven")?];
                if prior["decision"]["disposition"]["kind"] != "withdraw"
                    || prior["decision"]["disposition"]["controlRef"] != r["controlRef"]
                    || control["workId"] != work["workId"]
                    || control["action"] != "cancel"
                    || control["phase"] != "completed"
                {
                    return Err("intent_control_unproven");
                }
            }
            next["works"][work_id]["intentCoordination"] = merge(
                prior,
                &json!({"revision":r["workRevision"],"lifecycle":r["lifecycle"],"closure":r,"updatedAt":r["at"]}),
            );
            put(
                &mut next,
                "intentDecisions",
                id(&r["operationId"])?,
                r.clone(),
            )?;
        }
        "intent_assessed" => {
            let a = &e["assessment"];
            let r = &e["receipt"];
            if !assessment(a) {
                return Err("intent_event_invalid");
            }
            let goal = num(&next["mandates"][work_id]["goalRevision"]).unwrap_or(0);
            if a["workId"] != work["workId"]
                || r["workId"] != work["workId"]
                || r["operationId"] != a["operationId"]
                || !digest_matches(&r["digest"], a)
                || num(&r["workRevision"])
                    != num(&a["expectedWorkRevision"]).and_then(|n| n.checked_add(1))
                || num(&r["goalRevision"]) != Some(goal)
                || num(&prior["revision"]).unwrap_or(0)
                    != num(&a["expectedWorkRevision"]).unwrap_or(u64::MAX)
                || next["intentDecisions"]
                    .get(id(&r["operationId"])?)
                    .is_some()
                || !text(&r["at"], 100)
            {
                return Err("intent_revision_conflict");
            }
            let interpretation = if truth(&a["interpretation"]) {
                &a["interpretation"]
            } else {
                &prior["interpretation"]
            };
            if !self::interpretation(interpretation) {
                return Err("intent_interpretation_required");
            }
            let mut inputs = if prior["inputs"].is_object() {
                prior["inputs"].clone()
            } else {
                json!({})
            };
            for row in list(&a["inputs"]) {
                inputs[id(&row["inputId"])?] = row.clone();
            }
            let mut intent = json!({"schemaVersion":1,"revision":r["workRevision"],"goalRevision":r["goalRevision"],"interpretation":interpretation,"inputs":inputs,"coverage":a["coverage"],"decision":a,"lifecycle":"active","updatedAt":r["at"]});
            if truth(&r["turnId"]) {
                intent["decisionTurnId"] = r["turnId"].clone()
            }
            next["works"][work_id]["intentCoordination"] = intent;
            bucket(&mut next, "intentDecisions")?;
            put(
                &mut next,
                "intentDecisions",
                id(&r["operationId"])?,
                r.clone(),
            )?;
        }
        _ => return Err("intent_event_invalid"),
    }
    Ok(next)
}
