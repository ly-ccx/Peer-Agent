use super::{
    ExecutionResourceStore, HostClaimClosure, HostResourcePlan, ResourceError,
    claims::{self, open_handles},
    database::{self, get, same, values},
    next_revision, sorted_ids, sql_json, stamp, text,
};
use peer_protocol::javascript_json_digest;
use rusqlite::Connection;
use serde_json::{Value, json};

impl ExecutionResourceStore {
    /// Persistence of a Host-authorized closure. This port does not authenticate
    /// authority_ref or derive policy authority from arbitrary text.
    pub fn close_claim(
        &mut self,
        plan: &HostResourcePlan,
        request: HostClaimClosure<'_>,
    ) -> Result<Value, ResourceError> {
        plan.check()?;
        stamp(request.at)?;
        if plan.read_only {
            return Err(ResourceError::ReadOnly);
        }
        if request.claim_id.is_empty()
            || request.claim_id.len() > 8192
            || request.claim_revision == 0
            || request.claim_revision >= 9_007_199_254_740_991
            || request.authority_ref.is_empty()
            || request.authority_ref.len() > 8192
            || !matches!(request.proof, "verified_dead" | "legacy_user_confirmed")
        {
            return Err(ResourceError::ClosureInvalid);
        }
        let mut unknown = super::borrowed_ids(request.unknown_calls)?;
        unknown.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        if let Some(resolution) = request.resolution {
            sql_json(resolution)?;
            if !resolution.is_object()
                || !matches!(
                    resolution["tier"].as_str(),
                    Some("user_confirmed" | "bot_verified")
                )
                || !matches!(
                    resolution["verdict"].as_str(),
                    Some("no_effect_observed" | "effect_observed")
                )
                || text(&resolution["evidenceDigest"]).is_err()
                || resolution.get("policyRef").is_some_and(|v| !v.is_string())
                || resolution["tier"] == "bot_verified" && text(&resolution["policyRef"]).is_err()
            {
                return Err(ResourceError::ClosureInvalid);
            }
        }
        self.transaction(|c| apply_closure(c, plan, request, &unknown))
    }
    pub fn retained_unknowns(&self, plan: &HostResourcePlan) -> Result<Vec<Value>, ResourceError> {
        plan.check()?;
        self.read(|c| {
            Ok(
                values(c, "SELECT value FROM retained_unknowns ORDER BY id", [])?
                    .into_iter()
                    .filter(|v| same(&v["execution"], &plan.execution))
                    .collect(),
            )
        })
    }
    pub fn resolutions_for(&self, plan: &HostResourcePlan) -> Result<Vec<Value>, ResourceError> {
        plan.check()?;
        self.read(|c| {
            Ok(values(c, "SELECT value FROM resolutions ORDER BY id", [])?
                .into_iter()
                .filter(|v| same(&v["execution"], &plan.execution))
                .collect())
        })
    }
    pub fn resolution_for(&self, claim_id: &str) -> Result<Option<Value>, ResourceError> {
        self.read(|c| {
            Ok(values(
                c,
                "SELECT value FROM resolutions WHERE claimId=? ORDER BY id LIMIT 1",
                [claim_id],
            )?
            .pop())
        })
    }
    pub fn reconciliation_evidence_for(&self, claim_id: &str) -> Result<Vec<Value>, ResourceError> {
        self.read(|c| {
            values(
                c,
                "SELECT value FROM reconciliation_evidence WHERE claimId=? ORDER BY id",
                [claim_id],
            )
        })
    }
    pub fn record_reconciliation(&mut self, evidence: &Value) -> Result<Value, ResourceError> {
        let valid = text(&evidence["claimId"]).is_ok()
            && super::revision(&evidence["claimRevision"]).is_ok()
            && text(&evidence["evidenceDigest"]).is_ok()
            && matches!(
                evidence["verdict"].as_str(),
                Some(
                    "no_effect_observed" | "effect_observed" | "inconclusive" | "unfenced_external"
                )
            )
            && evidence["probes"]
                .as_array()
                .filter(|a| a.len() <= 64)
                .is_some_and(|a| {
                    a.iter().all(|p| {
                        p.is_object()
                            && matches!(
                                p["kind"].as_str(),
                                Some("process" | "handle" | "workspace" | "git" | "receipt")
                            )
                            && text(&p["ref"]).is_ok()
                            && p["result"].is_string()
                            && p["observedAt"].is_string()
                            && text(&p["digest"]).is_ok()
                    })
                });
        if !valid {
            return Err(ResourceError::ReconciliationInvalid);
        }
        let record = sql_json(evidence)?;
        self.transaction(|c| {
            let id = format!("recon-{}", text(&evidence["evidenceDigest"])?);
            if let Some(previous) = get(c, "reconciliation_evidence", &id)? {
                return Ok(previous);
            }
            c.execute(
                "INSERT INTO reconciliation_evidence VALUES(?,?,?)",
                rusqlite::params![id, text(&evidence["claimId"])?, record],
            )?;
            Ok(evidence.clone())
        })
    }
}

fn resolution_record(
    claim: &Value,
    request: &HostClaimClosure<'_>,
    unknown: &[String],
) -> Result<Option<Value>, ResourceError> {
    let Some(resolution) = request.resolution else {
        return Ok(None);
    };
    let id = format!(
        "resolution-{}",
        javascript_json_digest(&json!([
            claim["claimId"],
            claim["revision"],
            resolution["evidenceDigest"],
            request.authority_ref
        ]))
        .map_err(|_| ResourceError::Limit)?
    );
    let scope = claim
        .get("scope")
        .cloned()
        .or_else(|| super::scopes::scope_for_ref(claim["resourceRef"].as_str().unwrap()));
    let mut record = json!({"resolutionId":id,"claimId":claim["claimId"],"claimRevision":claim["revision"],
        "execution":claim["execution"],"scope":scope,"verdict":resolution["verdict"],"evidenceDigest":resolution["evidenceDigest"],
        "tier":resolution["tier"],"authorityRef":request.authority_ref,"unknownCalls":unknown,"at":request.at});
    if let Some(policy) = resolution
        .get("policyRef")
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
    {
        record["policyRef"] = policy.clone();
    }
    Ok(Some(record))
}

fn apply_closure(
    c: &Connection,
    plan: &HostResourcePlan,
    request: HostClaimClosure<'_>,
    unknown: &[String],
) -> Result<Value, ResourceError> {
    let mut claim = claims::claims(c, Some(request.claim_id))?
        .pop()
        .ok_or(ResourceError::ClaimMissing)?;
    if !same(&claim["execution"], &plan.execution) {
        return Err(ResourceError::ClaimScope);
    }
    let closure_id = format!(
        "closure-{}",
        javascript_json_digest(&json!([
            request.claim_id,
            request.claim_revision,
            request.authority_ref,
            unknown
        ]))
        .map_err(|_| ResourceError::Limit)?
    );
    if let Some(previous) = get(c, "closures", &closure_id)? {
        return Ok(previous);
    }
    if !matches!(claim["state"].as_str(), Some("draining" | "reconciling")) {
        return Err(ResourceError::ClaimActive);
    }
    if super::revision(&claim["revision"])? != request.claim_revision {
        return Err(ResourceError::ClosureStale);
    }
    if open_handles(&claim).next().is_some() {
        return Err(ResourceError::StopUnconfirmed);
    }
    if unknown != sorted_ids(&claim["evidenceCalls"])? {
        return Err(ResourceError::UnknownMismatch);
    }
    let resolution = resolution_record(&claim, &request, unknown)?;
    let mut receipt = json!({"closureId":closure_id,"claimId":claim["claimId"],"claimRevision":claim["revision"],
        "execution":claim["execution"],"resourceRef":claim["resourceRef"],"unknownCalls":unknown,"authorityRef":request.authority_ref,
        "proof":request.proof,"scope":"managed_execution","at":request.at});
    if let Some(record) = &resolution {
        let mut summary = json!({"resolutionId":record["resolutionId"],"tier":record["tier"],"verdict":record["verdict"],"evidenceDigest":record["evidenceDigest"]});
        if let Some(policy) = record.get("policyRef") {
            summary["policyRef"] = policy.clone();
        }
        receipt["resolution"] = summary;
    }
    claim["revision"] = next_revision(&claim)?;
    claim["state"] = "released".into();
    claim["closureId"] = closure_id.clone().into();
    claim["releasedUnknownCalls"] = json!(unknown);
    claim["releaseAuthorityRef"] = request.authority_ref.into();
    claim["releaseProof"] = request.proof.into();
    claim["releasedAt"] = request.at.into();
    claim["updatedAt"] = request.at.into();
    database::put_claim(c, &claim)?;
    c.execute(
        "INSERT INTO closures VALUES(?,?,?,?,?,?)",
        rusqlite::params![
            closure_id,
            plan.execution.plan_id,
            plan.execution.session_id,
            plan.execution.execution_epoch,
            text(&claim["resourceRef"])?,
            sql_json(&receipt)?
        ],
    )?;
    if let Some(record) = resolution {
        c.execute(
            "INSERT INTO resolutions VALUES(?,?,?)",
            rusqlite::params![
                text(&record["resolutionId"])?,
                request.claim_id,
                sql_json(&record)?
            ],
        )?;
    }
    let mut retained = receipt.clone();
    retained["planId"] = plan.execution.plan_id.clone().into();
    retained["sessionId"] = plan.execution.session_id.clone().into();
    retained["title"] = claim.get("title").cloned().unwrap_or_else(|| "".into());
    c.execute(
        "INSERT INTO retained_unknowns VALUES(?,?)",
        rusqlite::params![closure_id, sql_json(&retained)?],
    )?;
    c.execute(
        "INSERT INTO resource_events(resource,operationId) VALUES(?,?)",
        rusqlite::params![
            text(&claim["resourceRef"])?,
            format!("claim-closure:{closure_id}")
        ],
    )?;
    Ok(receipt)
}
