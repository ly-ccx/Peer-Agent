use super::{
    ExecutionResourceStore, HostDispatchScopes, HostResourcePlan, ResourceError,
    claims::{self, execution_json, open_handles},
    database::{get, put_claim, same},
    ids, next_revision, revision, scopes, sql_json, stamp, text,
};
use peer_protocol::{ExecutionResourceScope, javascript_json_digest};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn narrowing(
    plan: &HostResourcePlan,
    unknown: &[String],
    dispatches: &[HostDispatchScopes],
) -> Option<Vec<(scopes::ResourceIdentity, Vec<String>)>> {
    if dispatches.len() > 4096 {
        return None;
    }
    let primary = claims::primary(plan, true).ok()??;
    let mut files: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for id in unknown {
        let row = dispatches.iter().rev().find(|r| &r.tool_call_id == id)?;
        let [ExecutionResourceScope::File { path }] = row.scopes.as_slice() else {
            return None;
        };
        if !std::path::Path::new(path).is_absolute() {
            return None;
        }
        files.entry(path.clone()).or_default().push(id.clone());
    }
    let mut result = Vec::new();
    for (path, mut ids) in files {
        let resource = scopes::file_resource(path, true).ok()?;
        if !scopes::resource_conflicts(&resource.resource_ref, &primary.resource_ref) {
            return None;
        }
        ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        ids.dedup();
        result.push((resource, ids));
    }
    Some(result)
}

fn validate_receipt(plan: &HostResourcePlan, receipt: &Value) -> Result<(), ResourceError> {
    sql_json(receipt)?;
    let valid_claims = receipt["resourceClaims"]
        .as_array()
        .filter(|a| a.len() <= 4096)
        .is_some_and(|a| {
            a.iter()
                .all(|r| text(&r["claimId"]).is_ok() && revision(&r["revision"]).is_ok())
        });
    if !valid_claims
        || text(&receipt["receiptId"]).is_err()
        || text(&receipt["operationId"]).is_err()
        || receipt["scope"] != "managed_execution"
        || ids(&receipt["unknownCalls"]).is_err()
        || !same(&receipt["execution"], &plan.execution)
        || !["admissionClosed", "runnerIdle", "schedulerIdle"]
            .iter()
            .all(|k| receipt[*k] == true)
    {
        return Err(ResourceError::ReceiptInvalid);
    }
    Ok(())
}
fn event(c: &Connection, reference: &str, operation: &str) -> Result<(), ResourceError> {
    c.execute(
        "INSERT INTO resource_events(resource,operationId) VALUES(?,?)",
        [reference, operation],
    )?;
    Ok(())
}

impl ExecutionResourceStore {
    /// The Host supplies a current durable stop-barrier receipt. Parsing this
    /// object alone never proves that execution has stopped.
    pub fn settle(
        &mut self,
        plan: &HostResourcePlan,
        receipt: &Value,
        dispatches: &[HostDispatchScopes],
        at: &str,
    ) -> Result<Value, ResourceError> {
        plan.check()?;
        stamp(at)?;
        if plan.read_only {
            return Ok(Value::Null);
        }
        validate_receipt(plan, receipt)?;
        let digest = javascript_json_digest(receipt).map_err(|_| ResourceError::Limit)?;
        self.transaction(|c| apply_settlement(c, plan, receipt, dispatches, at, &digest))
    }
    pub fn rebind_requirements(
        &mut self,
        from: &peer_protocol::SessionExecutionIdentity,
        to: &peer_protocol::SessionExecutionIdentity,
        receipt_id: &str,
    ) -> Result<(), ResourceError> {
        self.transaction(|c| {
            let Some(mut request) = get(c, "requirements", &from.plan_id)? else {
                return Ok(());
            };
            if same(&request["execution"], to) {
                return Ok(());
            }
            let recorded = get(c, "receipts", &format!("resource-settlement:{receipt_id}"))?;
            if from.plan_id != to.plan_id
                || from.session_id != to.session_id
                || !same(&request["execution"], from)
                || !recorded
                    .as_ref()
                    .is_some_and(|r| same(&r["execution"], from))
            {
                return Err(ResourceError::ReceiptInvalid);
            }
            request["execution"] = execution_json(to);
            c.execute(
                "UPDATE requirements SET value=? WHERE planId=?",
                rusqlite::params![sql_json(&request)?, from.plan_id],
            )?;
            Ok(())
        })
    }
}

fn apply_settlement(
    c: &Connection,
    plan: &HostResourcePlan,
    receipt: &Value,
    dispatches: &[HostDispatchScopes],
    at: &str,
    digest: &str,
) -> Result<Value, ResourceError> {
    let id = format!("resource-settlement:{}", text(&receipt["receiptId"])?);
    if let Some(previous) = get(c, "receipts", &id)? {
        if previous["requestDigest"].as_str() != Some(digest) {
            return Err(ResourceError::ReceiptConflict);
        }
        return Ok(previous);
    }
    let current = claims::claims(c, None)?;
    let mut selected = Vec::new();
    for reference in receipt["resourceClaims"].as_array().unwrap() {
        if let Some(claim) = current
            .iter()
            .find(|r| r["claimId"] == reference["claimId"])
        {
            if !same(&claim["execution"], &plan.execution)
                || revision(&claim["revision"])? != revision(&reference["revision"])?
            {
                return Err(ResourceError::ReceiptStale);
            }
            selected.push(claim.clone());
        }
    }
    let unknown = ids(&receipt["unknownCalls"])?;
    if selected.iter().flat_map(open_handles).any(|h| {
        h["toolCallId"]
            .as_str()
            .is_none_or(|id| !unknown.iter().any(|s| s == id))
    }) {
        return Err(ResourceError::StopUnconfirmed);
    }
    let narrowed = if unknown.is_empty() {
        None
    } else {
        narrowing(plan, &unknown, dispatches)
    };
    let primary = claims::primary(plan, true)?.ok_or(ResourceError::Scope)?;
    for mut claim in selected {
        if !unknown.is_empty()
            && claim["state"] == "reconciling"
            && claim["operationId"] == receipt["operationId"]
            && claim["evidenceCalls"] == json!(unknown)
        {
            continue;
        }
        if let Some(files) = &narrowed
            && claim["resourceRef"].as_str() == Some(&primary.resource_ref)
        {
            claim["revision"] = next_revision(&claim)?;
            claim["state"] = "released".into();
            claim["releaseProof"] = "scope_narrowed".into();
            claim["releasedAt"] = at.into();
            claim["updatedAt"] = at.into();
            put_claim(c, &claim)?;
            event(
                c,
                &primary.resource_ref,
                &format!("scope-narrow:{}", text(&receipt["operationId"])?),
            )?;
            for (resource, calls) in files {
                protect_file(c, &claim, resource, calls, receipt, at)?;
            }
            continue;
        }
        claim["revision"] = next_revision(&claim)?;
        claim["state"] = if unknown.is_empty() {
            "released"
        } else {
            "reconciling"
        }
        .into();
        claim["evidenceCalls"] = json!(unknown);
        claim["operationId"] = receipt["operationId"].clone();
        claim["updatedAt"] = at.into();
        put_claim(c, &claim)?;
        event(
            c,
            text(&claim["resourceRef"])?,
            text(&receipt["operationId"])?,
        )?;
    }
    let result = json!({"receiptId":receipt["receiptId"],"requestDigest":digest,"execution":receipt["execution"],"updatedAt":at});
    c.execute(
        "INSERT INTO receipts VALUES(?,?)",
        rusqlite::params![id, sql_json(&result)?],
    )?;
    Ok(result)
}

fn protect_file(
    c: &Connection,
    parent: &Value,
    resource: &scopes::ResourceIdentity,
    calls: &[String],
    receipt: &Value,
    at: &str,
) -> Result<(), ResourceError> {
    let hash = javascript_json_digest(&json!([resource.resource_ref, parent["execution"]]))
        .map_err(|_| ResourceError::Limit)?;
    let claim_id = format!("claim-{hash}");
    let previous = claims::claims(c, Some(&claim_id))?.pop();
    if previous
        .as_ref()
        .is_some_and(|p| p.get("closureId").is_some())
    {
        return Ok(());
    }
    let mut evidence = if let Some(p) = &previous {
        ids(&p["evidenceCalls"])?
    } else {
        vec![]
    };
    for id in calls {
        if !evidence.contains(id) {
            evidence.push(id.clone());
        }
    }
    let next_revision = if let Some(p) = &previous {
        revision(&p["revision"])? + 1
    } else {
        1
    };
    let mut next = json!({"claimId":claim_id,"resourceRef":resource.resource_ref,"identity":resource.identity,
        "execution":parent["execution"],"workspaceId":parent["workspaceId"],"title":parent["title"],
        "state":"reconciling","revision":next_revision,"evidenceCalls":evidence,"operationId":receipt["operationId"],
        "scope":scopes::scope_for_ref(&resource.resource_ref),"updatedAt":at});
    if let Some(host) = parent.get("hostEpoch") {
        next["hostEpoch"] = host.clone();
    }
    put_claim(c, &next)?;
    event(c, &resource.resource_ref, text(&receipt["operationId"])?)
}
