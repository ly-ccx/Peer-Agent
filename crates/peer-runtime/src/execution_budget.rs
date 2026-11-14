//! Canonical work-budget transactions. No second execution journal/checkpoint.
use crate::{
    coordination::NativeCoordinationReducer,
    session_host::{HostError, NativeSessionHost},
};
use peer_protocol::{ExecutionResourceScope, javascript_json_digest};
use serde_json::{Value, json};
pub(crate) struct EpisodeBudget {
    pub work: String,
    pub attempt: String,
    pub plan: String,
    pub session: String,
    pub native_recorder: Value,
}
/// Existing runtimeWorkHeld / work-budget work_session ordering. A stopped
/// parent reply may leave child work active; a work stop closes every executor.
pub(crate) fn worker_work_stopped(work: &Value) -> bool {
    let truth = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    };
    let state = work["state"].as_str().unwrap_or("");
    let held = truth(&work["pendingControl"])
        || work["end"] == "user_stopped"
        || work["stopScope"] == "work" && matches!(state, "paused" | "cancelled");
    let stopped = held
        || matches!(
            state,
            "paused" | "cancelled" | "budget_limited" | "blocked_system" | "coalesced"
        );
    stopped && (work["stopScope"] != "reply" || matches!(state, "budget_limited" | "coalesced"))
}
pub(crate) struct DispatchFacts<'a> {
    pub call: &'a str,
    pub capability: &'a str,
    pub scopes: &'a [ExecutionResourceScope],
    pub stream: &'a str,
    pub conversation: &'a str,
}
impl EpisodeBudget {
    pub(crate) fn validate_existing(b: &Value) -> Result<(), HostError> {
        if b.is_null() {
            return Ok(());
        }
        if !b.is_object() {
            return Err(HostError("work_budget_invalid"));
        }
        for key in ["modelRequests", "toolCalls", "tokens"] {
            if b.get(key)
                .is_some_and(|v| v.as_u64().is_none_or(|n| n > 9_007_199_254_740_991))
            {
                return Err(HostError("work_budget_invalid"));
            }
        }
        if b.get("costUsd")
            .is_some_and(|v| v.as_f64().is_none_or(|n| !n.is_finite() || n < 0.0))
            || b.get("attempts").is_some_and(|v| !v.is_object())
            || b.get("uncertainDispatches").is_some_and(|v| !v.is_array())
            || b.get("limits").is_some_and(|v| !v.is_object())
        {
            return Err(HostError("work_budget_invalid"));
        }
        Ok(())
    }
    fn change(
        &self,
        host: &mut NativeSessionHost,
        now: &str,
        require_active: bool,
        update: impl FnOnce(&mut Value) -> Result<(), HostError>,
    ) -> Result<(), HostError> {
        let snapshot = host.journal.read(&NativeCoordinationReducer, None)?;
        let mut work = snapshot.state["works"][&self.work].clone();
        if !work.is_object() {
            return Err(HostError("work_budget_host_unavailable"));
        }
        if require_active && worker_work_stopped(&work) {
            return Err(HostError("work_execution_stopped"));
        }
        Self::validate_existing(&work["budget"])?;
        if work["budget"].is_null() {
            work["budget"] = json!({"modelRequests":0,"toolCalls":0,"tokens":0,"costUsd":0,"unknownUsage":false,"unknownCost":false,"attempts":{}})
        }
        update(&mut work["budget"])?;
        host.journal.append(
            &snapshot,
            &json!({"kind":"work","work":work}),
            super::session_host::milliseconds(now)?,
            &NativeCoordinationReducer,
            None,
        )?;
        Ok(())
    }
    fn boundary(b: &Value, metric: &str, cap: &str) -> Result<(), HostError> {
        let l = &b["limits"];
        if !l[cap].is_null() {
            let max = l[cap]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or(HostError("work_budget_policy_invalid"))?;
            let used = match b.get(metric) {
                None => 0.0,
                Some(v) => v
                    .as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .ok_or(HostError("work_budget_invalid"))?,
            };
            if used >= max
                || metric == "tokens" && b["unknownUsage"] == true
                || metric == "costUsd" && b["unknownCost"] == true
            {
                return Err(HostError("work_budget_limited"));
            }
        }
        Ok(())
    }
    pub fn request(&self, host: &mut NativeSessionHost, now: &str) -> Result<(), HostError> {
        self.change(host,now,true,|b|{
            let relevant=|r:&Value|r["planId"].as_str().is_none_or(|p|p==self.plan);
            if b["uncertainDispatches"].as_array().is_some_and(|a|a.iter().any(relevant)) || b["attempts"].as_object().into_iter().flat_map(|m|m.values()).filter(|a|relevant(a)).any(|a|a["pendingTools"].as_array().is_some_and(|p|!p.is_empty())){return Err(HostError("execution_outcome_unknown"))}
            for (m,c) in [("modelRequests","maxModelRequests"),("tokens","maxTokens"),("costUsd","maxCostUsd")] {Self::boundary(b,m,c)?}
            let n=b["modelRequests"].as_u64().unwrap_or(0).checked_add(1).filter(|n|*n<=9_007_199_254_740_991).ok_or(HostError("work_budget_limited"))?;b["modelRequests"]=json!(n);
            if !b["attempts"].is_object(){b["attempts"]=json!({})}
            if b["attempts"][&self.attempt].is_null(){b["attempts"][&self.attempt]=json!({"role":"work_session","planId":self.plan,"sessionId":self.session,"requests":0,"nativeRecorder":self.native_recorder})}
            let row=&mut b["attempts"][&self.attempt];row["requests"]=json!(row["requests"].as_u64().unwrap_or(0)+1);Ok(())
        })
    }
    pub fn usage(
        &self,
        host: &mut NativeSessionHost,
        usage: Option<&Value>,
        now: &str,
    ) -> Result<(), HostError> {
        self.change(host, now, false, |b| {
            if let Some(n) = usage
                .and_then(|u| u["total_tokens"].as_u64())
                .filter(|n| *n <= 9_007_199_254_740_991)
            {
                let total = b["tokens"]
                    .as_u64()
                    .unwrap_or(0)
                    .checked_add(n)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(HostError("work_budget_limited"))?;
                b["tokens"] = json!(total)
            } else {
                b["unknownUsage"] = json!(true)
            }
            b["unknownCost"] = json!(true);
            Ok(())
        })
    }
    pub fn dispatch(
        &self,
        host: &mut NativeSessionHost,
        facts: DispatchFacts<'_>,
        now: &str,
    ) -> Result<String, HostError> {
        let DispatchFacts {
            call,
            capability,
            scopes,
            stream,
            conversation,
        } = facts;
        let digest = javascript_json_digest(&json!([self.work, self.attempt, call]))
            .map_err(|_| HostError("work_budget_invalid"))?;
        let id = format!("dispatch-{}", &digest[..32]);
        self.change(host,now,true,|b|{
            Self::boundary(b,"toolCalls","maxToolCalls")?;
            let attempt=&mut b["attempts"][&self.attempt];if !attempt.is_object(){return Err(HostError("work_budget_host_unavailable"))}
            if !attempt["pendingTools"].is_array(){attempt["pendingTools"]=json!([])}
            let mut row=json!({"toolCallId":call,"capabilityId":capability,"dispatchId":id,"registeredAt":now,"streamId":stream,"conversationId":conversation,"nativeRecorder":self.native_recorder});
            // Canonical dispatch scope grammar accepts file/git_ref/remote_object;
            // Shell directory scopes are not falsely narrowed to file proofs.
            let declared:Vec<_>=scopes.iter().filter(|s|matches!(s,ExecutionResourceScope::File{..})).collect();
            if !declared.is_empty(){row["declaredScopes"]=json!(declared)}
            attempt["pendingTools"].as_array_mut().unwrap().push(row);
            b["toolCalls"]=json!(b["toolCalls"].as_u64().unwrap_or(0)+1);Ok(())
        })?;
        Ok(id)
    }
    pub fn settle(
        &self,
        host: &mut NativeSessionHost,
        call: &str,
        dispatch: &str,
        result: &Value,
        now: &str,
    ) -> Result<(), HostError> {
        if result["error"]["code"] == "execution_outcome_unknown" {
            return Ok(());
        }
        self.change(host,now,false,|b|{
            let a=&mut b["attempts"][&self.attempt];let pending=a["pendingTools"].as_array_mut().ok_or(HostError("work_budget_invalid"))?;
            if !pending.iter().any(|r|r["toolCallId"]==call && r["dispatchId"]==dispatch){return Err(HostError("work_budget_invalid"))}
            pending.retain(|r|r["toolCallId"]!=call);
            if !a["settledTools"].is_array(){a["settledTools"]=json!([])}
            let refs=peer_protocol::collect_tool_result_evidence_refs(Some(call),result).map_err(|_|HostError("work_budget_invalid"))?;
            a["settledTools"].as_array_mut().unwrap().push(json!({"dispatchId":dispatch,"toolCallId":call,"outcome":if result["status"]=="denied"{"not_dispatched"}else if result["status"]=="cancelled"{"terminated"}else{"resulted"},"evidenceRefs":refs,"settledAt":now}));Ok(())
        })
    }
    pub fn finish(&self, host: &mut NativeSessionHost, now: &str) -> Result<(), HostError> {
        self.change(host, now, false, |b| {
            let a = b["attempts"]
                .as_object_mut()
                .and_then(|m| m.shift_remove(&self.attempt))
                .unwrap_or(Value::Null);
            if !b["uncertainDispatches"].is_array() {
                b["uncertainDispatches"] = json!([])
            }
            for mut row in a["pendingTools"].as_array().cloned().unwrap_or_default() {
                row["attemptId"] = json!(self.attempt);
                row["role"] = json!("work_session");
                row["planId"] = json!(self.plan);
                row["sessionId"] = json!(self.session);
                b["uncertainDispatches"].as_array_mut().unwrap().push(row)
            }
            if !b["dispatchReceipts"].is_object() {
                b["dispatchReceipts"] = json!({})
            }
            for row in a["settledTools"].as_array().into_iter().flatten() {
                let id = row["dispatchId"]
                    .as_str()
                    .ok_or(HostError("work_budget_invalid"))?;
                b["dispatchReceipts"][id] = row.clone()
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_work_budget_worker_stop_ordering_matches() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/native-context-wire.json"
        ))
        .unwrap();
        for c in f["workCases"].as_array().unwrap() {
            assert_eq!(
                !worker_work_stopped(&c["input"]),
                c["allowed"].as_bool().unwrap(),
                "{}",
                c["input"]
            );
        }
    }
    #[test]
    fn corrupt_existing_budget_is_preserved_as_a_blocker() {
        for b in [
            json!("bad"),
            json!({"modelRequests":-1}),
            json!({"tokens":"unknown"}),
            json!({"costUsd":-1}),
            json!({"attempts":[]}),
            json!({"limits":"Full"}),
        ] {
            assert!(EpisodeBudget::validate_existing(&b).is_err());
        }
    }
}
