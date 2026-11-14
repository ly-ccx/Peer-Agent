//! Native CLI canonical Goal execution projection. Mirrors the current TUI
//! getPlan read path; live ownership, permissions and stop proof remain Host facts.
use peer_protocol::{
    GoalFactProjector, javascript_json_string, javascript_trim,
    normalize_session_execution_identity,
};
use serde_json::{Value, json};
mod origin;
pub struct TuiGoalProjector {
    now: String,
}
fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn string(v: &Value) -> Result<String, &'static str> {
    Ok(match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(_) => javascript_json_string(v).map_err(|_| "GOAL_VALUE_UNREPRESENTABLE")?,
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() {
                    Ok(String::new())
                } else {
                    string(v)
                }
            })
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
    })
}
fn optional(v: &Value) -> Result<Option<String>, &'static str> {
    if v.is_null() {
        return Ok(None);
    }
    let s = string(v)?;
    let s = javascript_trim(&s);
    Ok((!s.is_empty()).then(|| s.to_owned()))
}
fn raw_text(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !javascript_trim(s).is_empty())
}
fn count(v: &Value) -> f64 {
    v.as_f64()
        .filter(|n| n.is_finite())
        .map_or(0.0, |n| n.trunc().max(0.0))
}
fn date(v: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(
        javascript_trim(v),
        &time::format_description::well_known::Rfc3339,
    )
    .ok()
}
fn runner(raw: &Value, now: &str) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let status = raw["status"]
        .as_str()
        .filter(|s| {
            [
                "idle",
                "running",
                "compacting_context",
                "resuming_after_compaction",
                "paused",
                "exploring",
                "waiting_user",
                "blocked",
                "budget_exhausted",
                "completed",
                "failed",
            ]
            .contains(s)
        })
        .unwrap_or("idle");
    let mut out = json!({"enabled":truth(&raw["enabled"]),"status":status,"turnCount":count(&raw["turnCount"]),"roundCount":count(&raw["roundCount"]),"toolCallCount":count(&raw["toolCallCount"]),"explorerCount":count(&raw["explorerCount"]),"updatedAt":raw_text(&raw["updatedAt"]).unwrap_or(now)});
    if ["execute", "verify", "explore", "synthesize", "block"]
        .contains(&raw["intent"].as_str().unwrap_or(""))
    {
        out["intent"] = raw["intent"].clone()
    }
    if [
        "orient",
        "inspect",
        "plan_scaffold",
        "act",
        "verify",
        "repair",
        "quality_review",
        "synthesize",
        "waiting_user",
        "blocked",
    ]
    .contains(&raw["phase"].as_str().unwrap_or(""))
    {
        out["phase"] = raw["phase"].clone()
    }
    for key in ["currentTaskId", "runId"] {
        if let Some(s) = raw_text(&raw[key]) {
            out[key] = json!(javascript_trim(s))
        }
    }
    let i = &raw["interruption"];
    if let (Some(source), Some(reason), Some(at)) = (
        raw_text(&i["source"]),
        raw_text(&i["reason"]),
        raw_text(&i["interruptedAt"]),
    ) {
        let source = javascript_trim(source);
        let origin = i["origin"]
            .as_str()
            .filter(|s| {
                [
                    "user",
                    "provider",
                    "host_handoff",
                    "lease_loss",
                    "tool",
                    "budget",
                    "unknown",
                ]
                .contains(s)
            })
            .unwrap_or(if ["runGoalTurn", "stream_error"].contains(&source) {
                "provider"
            } else {
                "unknown"
            });
        out["interruption"] = json!({"source":source,"origin":origin,"reason":javascript_trim(reason),"interruptedAt":javascript_trim(at),"recoverable":i["recoverable"]==true,"attempt":count(&i["attempt"]).max(1.0)});
    }
    if let Some(v) = raw.get("verificationContinuation") {
        out["verificationContinuation"] = v.clone()
    }
    Some(out)
}
#[derive(Default)]
struct Leaves {
    total: u64,
    completed: u64,
    failed: u64,
    blocked: u64,
    cancelled: u64,
}
fn leaves(tasks: &Value, out: &mut Leaves) -> Result<(), &'static str> {
    let Some(rows) = tasks.as_array() else {
        if tasks.is_null() {
            return Ok(());
        }
        return Err("GOAL_TASKS_INVALID");
    };
    for task in rows {
        if !task.is_object() {
            return Err("GOAL_TASKS_INVALID");
        }
        if task["subtasks"].as_array().is_some_and(|a| !a.is_empty()) {
            leaves(&task["subtasks"], out)?;
            continue;
        }
        out.total += 1;
        match task["status"].as_str().unwrap_or("") {
            "completed" => out.completed += 1,
            "failed" => out.failed += 1,
            "waiting_user" => out.blocked += 1,
            "cancelled" => out.cancelled += 1,
            _ => (),
        }
    }
    Ok(())
}
fn normalized(raw: &Value, now: &str, counts: &Leaves) -> Result<Value, &'static str> {
    let mut out = raw.clone();
    let mut status = if raw["approval"]["decision"] == "reject" {
        "cancelled"
    } else {
        raw["status"].as_str().ok_or("GOAL_STATUS_UNSUPPORTED")?
    };
    if ![
        "drafting",
        "awaiting_approval",
        "approved",
        "accepted",
        "executing",
        "paused",
        "interrupted",
        "failed",
        "completed",
        "cancelled",
    ]
    .contains(&status)
    {
        return Err("GOAL_STATUS_UNSUPPORTED");
    }
    let r = runner(&raw["runner"], now);
    if ["interrupted", "failed"].contains(&status)
        && counts.total > 0
        && counts.failed == 0
        && counts.completed + counts.cancelled == counts.total
    {
        let interrupted = r.as_ref().is_some_and(|r| {
            r.get("interruption").is_some()
                && !(r["status"] == "running" && r["interruption"]["recoverable"] == true)
        });
        if !interrupted {
            status = "completed"
        }
    }
    out["status"] = json!(status);
    out["runner"] = r.unwrap_or(Value::Null);
    out["conversationId"] = json!(optional(&raw["conversationId"])?);
    out["delegationOrigin"] = origin::normalize(&raw["delegationOrigin"])?.unwrap_or(Value::Null);
    Ok(out)
}
impl TuiGoalProjector {
    pub fn new(now: &str) -> Result<Self, &'static str> {
        if date(now).is_none() {
            return Err("GOAL_TIMESTAMP_UNSUPPORTED");
        }
        Ok(Self {
            now: now.to_owned(),
        })
    }
}
impl GoalFactProjector for TuiGoalProjector {
    fn execution_facts(
        &self,
        raw: &Value,
        progress: Option<&Value>,
    ) -> Result<Value, &'static str> {
        javascript_json_string(raw).map_err(|_| "GOAL_SOURCE_LIMIT")?;
        let mut counts = Leaves::default();
        leaves(&raw["tasks"], &mut counts)?;
        let mut current = normalized(raw, &self.now, &counts)?;
        let mut checkpoint = raw["runner"]
            .get("contextCheckpoint")
            .is_some_and(|v| v.is_object());
        if let Some(patch) = progress {
            let patch_at =
                raw_text(&patch["updatedAt"]).or_else(|| raw_text(&patch["runner"]["updatedAt"]));
            if let Some(stamp) = patch_at {
                let patch_time = date(stamp).ok_or("GOAL_TIMESTAMP_UNSUPPORTED")?;
                let plan_at = raw_text(&current["runner"]["updatedAt"])
                    .or_else(|| raw_text(&current["updatedAt"]));
                let plan_time = plan_at
                    .map(|s| date(s).ok_or("GOAL_TIMESTAMP_UNSUPPORTED"))
                    .transpose()?;
                if plan_time.is_none_or(|v| patch_time >= v) {
                    if patch["status"].is_string() {
                        current["status"] = patch["status"].clone()
                    }
                    current["runner"] = patch["runner"].clone();
                    if patch["updatedAt"].is_string() {
                        current["updatedAt"] = patch["updatedAt"].clone()
                    }
                    checkpoint = patch["runner"]
                        .get("contextCheckpoint")
                        .is_some_and(Value::is_object);
                    current = normalized(&current, &self.now, &counts)?;
                }
            }
        }
        let status = current["status"].as_str().unwrap();
        let origin = &current["delegationOrigin"];
        let r = &current["runner"];
        let stopped = ["cancelled", "paused", "interrupted"].contains(&status)
            || ["cancelled", "paused", "superseded"]
                .contains(&origin["phase"].as_str().unwrap_or(""))
            || truth(&origin["supersededBy"])
            || truth(&origin["cancellation"]);
        let execution = if !origin.is_null() {
            let mut identity = json!({"planId":raw["planId"],"sessionId":origin["sessionId"],"executionEpoch":origin["coordinationBinding"]["executionEpoch"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("legacy:{}:{}",raw["planId"].as_str().unwrap_or(""),origin["executionGeneration"].as_str().or_else(||raw["createdAt"].as_str()).unwrap_or("")))});
            if truth(&origin["executionGeneration"]) {
                identity["generation"] = origin["executionGeneration"].clone()
            }
            if origin["coordinationBinding"]["goalRevision"]
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
            {
                identity["goalRevision"] = origin["coordinationBinding"]["goalRevision"].clone()
            }
            normalize_session_execution_identity(&identity)
                .map(|_| identity)
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let percent = if counts.total == 0 {
            0
        } else {
            (counts.completed as f64 * 100.0 / counts.total as f64).round() as u64
        };
        let active = [
            "drafting",
            "awaiting_approval",
            "approved",
            "accepted",
            "executing",
            "paused",
            "interrupted",
            "failed",
        ]
        .contains(&status);
        let binding = &raw["deliveryBinding"];
        let directory = if origin["readOnly"] == true {
            None
        } else {
            (binding["executionIsolation"] == "worktree")
                .then(|| raw_text(&binding["worktreePath"]))
                .flatten()
                .or_else(|| raw_text(&raw["targetWorkspacePath"]))
                .or_else(|| raw_text(&binding["targetWorkspacePath"]))
                .or_else(|| raw_text(&raw["originWorkspacePath"]))
        };
        Ok(
            json!({"planId":raw["planId"],"conversationId":current["conversationId"],"status":current["status"],"version":raw.get("version").unwrap_or(&Value::Null),"createdAt":raw.get("createdAt").unwrap_or(&Value::Null),"updatedAt":current.get("updatedAt").unwrap_or(&Value::Null),"delegationOrigin":origin,"runner":r,"progress":{"total":counts.total,"completed":counts.completed,"failed":counts.failed,"blocked":counts.blocked,"percent":percent},"active":active,"inheritanceStopped":stopped,"execution":execution,"resourceDirectory":directory,"rawCheckpointDeclared":checkpoint,"requiresRuntimeCheck":true}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_goal_execution_facts_match_actual_ts_store() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/goal-execution-facts.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let projector = TuiGoalProjector::new(case["now"].as_str().unwrap()).unwrap();
            let facts = projector
                .execution_facts(&case["raw"], case.get("progress"))
                .unwrap_or_else(|e| panic!("{}: {e}", case["name"]));
            assert_eq!(
                javascript_json_string(&facts).unwrap(),
                javascript_json_string(&case["expected"]).unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
