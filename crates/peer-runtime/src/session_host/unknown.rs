use super::*;
use crate::{git_probe::GitStatusProbe, live_execution::Ownership, recorder};
use peer_protocol::{javascript_json_digest, javascript_json_string, javascript_object_keys};
use peer_store::{HostClaimClosure, PolicyStore};
use tokio_util::sync::CancellationToken;
fn values(v: &Value) -> Vec<&Value> {
    javascript_object_keys(v)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|k| v.get(k))
        .collect()
}
fn ids(v: &Value) -> Vec<String> {
    unique(
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned)),
    )
}
fn probe(
    probes: &mut Vec<Value>,
    kind: &str,
    reference: &str,
    result: Value,
    now: &str,
) -> Result<(), HostError> {
    let result_text =
        javascript_json_string(&result).map_err(|_| HostError("reconciliation_probe_limit"))?;
    if result_text.encode_utf16().count() > 4096 {
        return Err(HostError("reconciliation_probe_limit"));
    }
    let digest = javascript_json_digest(&json!({"kind":kind,"ref":reference,"result":result}))
        .map_err(|_| HostError("reconciliation_probe_limit"))?;
    probes.push(
        json!({"kind":kind,"ref":reference,"result":result_text,"observedAt":now,"digest":digest}),
    );
    Ok(())
}
async fn recorder_proof(current: &Current) -> &'static str {
    let control = control(current);
    if control["expectedExecution"] != current.goal.facts["execution"] {
        return "unproven";
    }
    match serde_json::from_value::<recorder::Recorder>(control["recorder"].clone()) {
        Ok(r) => recorder::prove(&r).await.as_str(),
        Err(_) => "not_available",
    }
}
fn find_claim(
    host: &NativeSessionHost,
    current: &Current,
    claim_id: &str,
) -> Result<Value, HostError> {
    if claim_id.is_empty() || claim_id.len() > 8192 {
        return Err(HostError("reconciliation_invalid_input"));
    }
    let claim = host
        .resources
        .claims_for(&current.resource)?
        .into_iter()
        .find(|c| c["claimId"] == claim_id)
        .ok_or(HostError("reconciliation_claim_missing"))?;
    if !matches!(claim["state"].as_str(), Some("draining" | "reconciling")) {
        return Err(HostError("reconciliation_claim_active"));
    }
    Ok(claim)
}
impl NativeSessionHost {
    /// Host-executed observations only. No tool replay and no model-declared
    /// verdict. Evidence binds the same claim revision, scope and execution.
    pub async fn reconcile_unknown(
        &mut self,
        plan_id: &str,
        claim_id: &str,
        now: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, HostError> {
        let current = self.current(plan_id, now)?;
        let claim = find_claim(self, &current, claim_id)?;
        let unknown = ids(&claim["evidenceCalls"]);
        if unknown.is_empty() {
            return Err(HostError("reconciliation_no_unknown"));
        }
        if unknown.len() > 60 {
            return Err(HostError("reconciliation_too_many_unknown"));
        }
        let work_id = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .unwrap_or("");
        let budget = &current.journal.state["works"][work_id]["budget"];
        let receipts = values(&budget["dispatchReceipts"]);
        let uncertain = budget["uncertainDispatches"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut probes = Vec::new();
        let mut fenced = true;
        let mut all_not_dispatched = true;
        for id in &unknown {
            let row = uncertain
                .iter()
                .find(|r| r["toolCallId"] == *id)
                .unwrap_or(&Value::Null);
            let receipt = receipts
                .iter()
                .copied()
                .find(|r| r["toolCallId"] == *id)
                .unwrap_or(&Value::Null);
            fenced &= row["capabilityId"]
                .as_str()
                .is_some_and(|s| s.starts_with("local."));
            all_not_dispatched &= receipt["outcome"] == "not_dispatched";
            probe(
                &mut probes,
                "receipt",
                &format!("receipt:{id}"),
                json!({"answered":receipt.get("outcome").unwrap_or(&Value::Null),"capabilityId":row["capabilityId"],"dispatchId":row.get("dispatchId").or_else(||receipt.get("dispatchId")).unwrap_or(&Value::Null),"registeredAt":row["registeredAt"]}),
                now,
            )?;
        }
        let handles: Vec<_> = values(&claim["handles"])
            .into_iter()
            .filter(|h| h["state"] != "ended")
            .filter_map(|h| h["handleId"].as_str().or_else(|| h["toolCallId"].as_str()))
            .collect();
        probe(
            &mut probes,
            "handle",
            &format!("handles:{claim_id}"),
            json!({"openHandles":handles}),
            now,
        )?;
        let proof = recorder_proof(&current).await;
        probe(
            &mut probes,
            "process",
            &format!("process:{}", current.resource.execution.session_id),
            json!({"recorderProof":proof}),
            now,
        )?;
        let directory = claim["resourceRef"]
            .as_str()
            .and_then(|s| s.strip_prefix("directory:"));
        let mut visible_changes = None;
        let workspace = if let Some(directory) = directory {
            match GitStatusProbe::default()
                .observe(Path::new(directory), cancel)
                .await
            {
                Ok(status) => {
                    visible_changes = Some(
                        status["changed"].as_u64().unwrap_or(0)
                            + status["untracked"].as_u64().unwrap_or(0)
                            > 0,
                    );
                    status
                }
                Err(error) => json!({"clean":null,"error":error.0}),
            }
        } else {
            json!({"clean":null,"error":"scope_not_directory"})
        };
        probe(
            &mut probes,
            "workspace",
            claim["resourceRef"]
                .as_str()
                .ok_or(HostError("reconciliation_invalid_input"))?,
            workspace,
            now,
        )?;
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let fresh = self.current(plan_id, now)?;
        if fresh.goal.source_revision != current.goal.source_revision
            || find_claim(self, &fresh, claim_id)?["revision"] != claim["revision"]
        {
            return Err(HostError("reconciliation_stale"));
        }
        let live = self
            .live
            .ownership(&current.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?
            == Ownership::Live;
        let verdict = if !fenced {
            "unfenced_external"
        } else if !handles.is_empty() || live || matches!(proof, "alive" | "unproven") {
            "inconclusive"
        } else if all_not_dispatched || visible_changes == Some(false) {
            "no_effect_observed"
        } else {
            "inconclusive"
        };
        let digest=javascript_json_digest(&json!({"claimId":claim["claimId"],"claimRevision":claim["revision"],"resourceRef":claim["resourceRef"],"verdict":verdict,"probes":probes.iter().map(|p|p["digest"].clone()).collect::<Vec<_>>()})).map_err(|_|HostError("reconciliation_probe_limit"))?;
        let scope = claim
            .get("scope")
            .cloned()
            .or_else(|| directory.map(|p| json!({"kind":"directory","path":p})));
        let mut evidence = json!({"execution":claim["execution"],"claimId":claim["claimId"],"claimRevision":claim["revision"],"probes":probes,"verdict":verdict,"evidenceDigest":digest});
        if let Some(scope) = scope {
            evidence["scope"] = scope;
        }
        Ok(self.resources.record_reconciliation(&evidence)?)
    }
    /// Policy-delegated occupancy closure. Shell/network/MCP/delegation stay
    /// outside this envelope even when an ordinary access policy is Full.
    pub async fn resolve_unknown_bot_verified(
        &mut self,
        plan_id: &str,
        claim_id: &str,
        now: &str,
    ) -> Result<Value, HostError> {
        let current = self.current(plan_id, now)?;
        let claim = find_claim(self, &current, claim_id)?;
        if self
            .live
            .ownership(&current.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?
            == Ownership::Live
        {
            return Err(HostError("live_execution"));
        }
        let policy_store = PolicyStore::new(&self.home);
        let (policy, revision) =
            policy_store.read_unknown_outcome_policy(&current.resource.workspace_id)?;
        if policy["tier"] != "bot_verified" {
            return Err(HostError("authorization_required"));
        }
        let unknown = ids(&claim["evidenceCalls"]);
        if unknown.is_empty() {
            return Err(HostError("no_unknown_calls"));
        }
        if values(&claim["handles"])
            .iter()
            .any(|h| h["state"] != "ended")
        {
            return Err(HostError("open_handles"));
        }
        let evidence = self
            .resources
            .reconciliation_evidence_for(claim_id)?
            .pop()
            .ok_or(HostError("reconciliation_missing"))?;
        if evidence["claimRevision"] != claim["revision"] {
            return Err(HostError("reconciliation_stale"));
        }
        if !matches!(
            evidence["verdict"].as_str(),
            Some("no_effect_observed" | "effect_observed")
        ) {
            return Err(HostError("reconciliation_inconclusive"));
        }
        let probes = evidence["probes"]
            .as_array()
            .ok_or(HostError("reconciliation_invalid_input"))?;
        let parse = |p: &Value| -> Option<Value> {
            peer_protocol::decode_json_bounded(
                p["result"].as_str()?.as_bytes(),
                peer_protocol::JsonLimits {
                    bytes: 16384,
                    nodes: 1024,
                    depth: 16,
                    string_bytes: 16384,
                },
            )
            .ok()
            .map(|v| v.value)
        };
        let process = probes
            .iter()
            .find(|p| p["kind"] == "process")
            .and_then(parse)
            .ok_or(HostError("recorder_not_proven_dead"))?;
        let dead = |p: &str| matches!(p, "dead" | "reused" | "different_boot");
        if !process["recorderProof"].as_str().is_some_and(dead)
            || !dead(recorder_proof(&current).await)
        {
            return Err(HostError("recorder_not_proven_dead"));
        }
        for id in &unknown {
            let result = probes
                .iter()
                .find(|p| p["kind"] == "receipt" && p["ref"] == format!("receipt:{id}"))
                .and_then(parse)
                .ok_or(HostError("capability_not_confined"))?;
            if !matches!(
                result["capabilityId"].as_str(),
                Some(
                    "local.file.read"
                        | "local.file.list"
                        | "local.file.search"
                        | "local.file.write"
                        | "local.file.edit"
                )
            ) {
                return Err(HostError("capability_not_confined"));
            }
        }
        let fresh = self.current(plan_id, now)?;
        if fresh.goal.source_revision != current.goal.source_revision
            || policy_store
                .read_unknown_outcome_policy(&current.resource.workspace_id)?
                .1
                != revision
        {
            return Err(HostError("permission_policy_changed"));
        }
        let authority = format!(
            "policy:{}",
            policy["policyId"]
                .as_str()
                .ok_or(HostError("authorization_required"))?
        );
        let resolution = json!({"tier":"bot_verified","verdict":evidence["verdict"],"evidenceDigest":evidence["evidenceDigest"],"policyRef":authority});
        let projector = TuiGoalProjector::new(now).map_err(HostError)?;
        let transaction = self.goals.prepare_execution_mirror(
            self.journal.lease(),
            plan_id,
            &fresh.goal.source_revision,
            &projector,
            None,
        )?;
        if policy_store
            .read_unknown_outcome_policy(&current.resource.workspace_id)?
            .1
            != revision
        {
            return Err(HostError("permission_policy_changed"));
        }
        let closure = self.resources.close_claim(
            &fresh.resource,
            HostClaimClosure {
                claim_id,
                claim_revision: claim["revision"]
                    .as_u64()
                    .ok_or(HostError("reconciliation_invalid_input"))?,
                authority_ref: &authority,
                unknown_calls: &unknown,
                proof: "verified_dead",
                resolution: Some(&resolution),
                at: now,
            },
        )?;
        if transaction
            .commit(GoalExecutionFact::ClaimClosure(&closure), now, None)
            .is_err()
        {
            return Err(HostError("STORE_COMMIT_UNCERTAIN"));
        }
        Ok(closure)
    }
}
