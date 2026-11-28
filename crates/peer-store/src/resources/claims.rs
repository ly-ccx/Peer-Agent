use super::{
    ExecutionResourceStore, HostResourcePlan, ResourceError, ResourceReservation,
    database::{self, get, put_claim, same},
    ids, next_revision, revision,
    scopes::{self, ResourceIdentity},
    stamp, text,
};
use peer_protocol::{ExecutionResourceScope, SessionExecutionIdentity};
use rusqlite::Connection;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub(super) fn execution_json(e: &SessionExecutionIdentity) -> Value {
    let mut v = Map::new();
    v.insert("planId".into(), e.plan_id.clone().into());
    v.insert("sessionId".into(), e.session_id.clone().into());
    v.insert("executionEpoch".into(), e.execution_epoch.clone().into());
    // executionIdentity(plan) inserts generation before goalRevision. This order
    // is part of existing JSON.stringify claim/receipt identities.
    if let Some(generation) = &e.generation {
        v.insert("generation".into(), generation.clone().into());
    }
    if let Some(revision) = e.goal_revision {
        v.insert("goalRevision".into(), revision.into());
    }
    Value::Object(v)
}
pub(super) fn primary(
    p: &HostResourcePlan,
    missing: bool,
) -> Result<Option<ResourceIdentity>, ResourceError> {
    p.check()?;
    if p.read_only {
        return Ok(None);
    }
    Ok(Some(scopes::directory_resource(
        p.directory.as_ref().ok_or(ResourceError::Scope)?,
        missing,
    )?))
}
pub(super) fn resource_set(
    p: &HostResourcePlan,
    scopes: &[ExecutionResourceScope],
) -> Result<Vec<ResourceIdentity>, ResourceError> {
    if scopes.len() > 32 {
        return Err(ResourceError::Scope);
    }
    let mut set = BTreeMap::new();
    if let Some(r) = primary(p, false)? {
        set.insert(r.resource_ref.clone(), r);
    }
    for scope in scopes {
        let r = match scope {
            ExecutionResourceScope::File { path } => scopes::file_resource(path, true)?,
            ExecutionResourceScope::Directory { path } => scopes::directory_resource(path, false)?,
            _ => return Err(ResourceError::Scope),
        };
        set.insert(r.resource_ref.clone(), r);
    }
    Ok(set.into_values().collect())
}
pub(super) fn required(
    c: &Connection,
    p: &HostResourcePlan,
    extra: &[ExecutionResourceScope],
) -> Result<Vec<ExecutionResourceScope>, ResourceError> {
    let mut scopes = if let Some(row) = get(c, "requirements", &p.execution.plan_id)? {
        if same(&row["execution"], &p.execution) {
            scopes::parse_scopes(&row["scopes"])?
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    for scope in extra {
        let path = scopes::scope_path(scope)?;
        if let Some(old) = scopes
            .iter_mut()
            .find(|s| scopes::scope_path(s).ok() == Some(path))
        {
            *old = scope.clone();
        } else {
            scopes.push(scope.clone());
        }
    }
    if scopes.len() > 32 {
        return Err(ResourceError::Scope);
    }
    Ok(scopes)
}
fn validate_claim(
    raw: &Value,
    columns: (&str, &str, &str, &str, &str, &str, &str, i64),
) -> Result<(), ResourceError> {
    let (id, plan, session, workspace, resource, epoch, state, rev) = columns;
    let e = peer_protocol::normalize_session_execution_identity(&raw["execution"])
        .ok_or(ResourceError::Invalid)?;
    if raw["claimId"].as_str() != Some(id)
        || e.plan_id != plan
        || e.session_id != session
        || e.execution_epoch != epoch
        || raw["workspaceId"].as_str() != Some(workspace)
        || raw["resourceRef"].as_str() != Some(resource)
        || raw["state"].as_str() != Some(state)
        || !matches!(
            state,
            "reserved" | "active" | "draining" | "reconciling" | "released"
        )
        || revision(&raw["revision"])? != rev as u64
        || scopes::scope_for_ref(resource).is_none()
    {
        return Err(ResourceError::Invalid);
    }
    text(&raw["identity"])?;
    ids(&raw["evidenceCalls"])?;
    if raw
        .get("handles")
        .is_some_and(|h| !h.is_null() && !h.is_object())
    {
        return Err(ResourceError::Invalid);
    }
    Ok(())
}
pub(super) fn claims(c: &Connection, id: Option<&str>) -> Result<Vec<Value>, ResourceError> {
    // Include either representation of an active claim; a corrupt disagreement
    // between indexed state and its JSON must fail rather than hide protection.
    let query = if id.is_some() {
        "SELECT id,planId,sessionId,workspaceId,resource,epoch,state,revision,value FROM claims WHERE id=?"
    } else {
        "SELECT id,planId,sessionId,workspaceId,resource,epoch,state,revision,value FROM claims WHERE state!='released' OR json_extract(value,'$.state')!='released'"
    };
    let mut statement = c.prepare(query)?;
    let mut rows = if let Some(id) = id {
        statement.query([id])?
    } else {
        statement.query([])?
    };
    let mut result = Vec::new();
    let mut bytes = 0;
    let mut nodes = 65_536;
    let mut strings = 8 * 1024 * 1024;
    while let Some(row) = rows.next()? {
        let raw: String = row.get(8)?;
        bytes += raw.len();
        if bytes > 8 * 1024 * 1024 || result.len() >= 4096 {
            return Err(ResourceError::Limit);
        }
        let decoded = peer_protocol::decode_json_bounded(
            raw.as_bytes(),
            peer_protocol::JsonLimits {
                bytes: 1_048_576,
                nodes,
                depth: 64,
                string_bytes: strings,
            },
        )
        .map_err(|_| ResourceError::Invalid)?;
        nodes -= decoded.nodes;
        strings -= decoded.string_bytes;
        let raw = decoded.value;
        validate_claim(
            &raw,
            (
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
                &row.get::<_, String>(2)?,
                &row.get::<_, String>(3)?,
                &row.get::<_, String>(4)?,
                &row.get::<_, String>(5)?,
                &row.get::<_, String>(6)?,
                row.get(7)?,
            ),
        )?;
        result.push(raw);
    }
    Ok(result)
}
pub(super) fn owned(
    p: &HostResourcePlan,
    resource: &ResourceIdentity,
    host_epoch: &str,
    at: &str,
) -> Result<Value, ResourceError> {
    let execution = execution_json(&p.execution);
    let hash = peer_protocol::javascript_json_digest(&json!([resource.resource_ref, execution]))
        .map_err(|_| ResourceError::Limit)?;
    Ok(
        json!({"claimId":format!("claim-{hash}"),"resourceRef":resource.resource_ref,"identity":resource.identity,"execution":execution,"workspaceId":p.workspace_id,"hostEpoch":host_epoch,"title":p.title,"state":"reserved","revision":1,"evidenceCalls":[],"updatedAt":at}),
    )
}
fn blocker(claim: &Value) -> Value {
    if matches!(claim["state"].as_str(), Some("draining" | "reconciling")) {
        let evidence = claim["evidenceCalls"].as_array().unwrap();
        let unknown = !evidence.is_empty();
        let mut b = json!({"kind":"protection","nextAction":if unknown{"reconcile_execution_outcome"}else{"confirm_execution_stopped"},"code":if unknown{"execution_outcome_unknown"}else{"execution_stop_unconfirmed"},"resourceRef":claim["resourceRef"],"claimId":claim["claimId"],"sessionId":claim["execution"]["sessionId"],"evidenceCalls":evidence,"closeClaimAvailable":!open_handles(claim).any(|_|true)});
        if let Some(op) = claim.get("operationId") {
            b["operationId"] = op.clone();
        }
        if let Some(scope) = claim
            .get("scope")
            .cloned()
            .or_else(|| scopes::scope_for_ref(claim["resourceRef"].as_str().unwrap()))
        {
            b["scope"] = scope;
        }
        b
    } else {
        json!({"kind":"owner","code":"resource_busy","resourceRef":claim["resourceRef"],"claimId":claim["claimId"],"sessionId":claim["execution"]["sessionId"],"title":claim.get("title").cloned().unwrap_or(Value::String(String::new()))})
    }
}
pub(super) fn open_handles(claim: &Value) -> impl Iterator<Item = &Value> {
    claim
        .get("handles")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|v| v.values())
        .filter(|h| h["state"].as_str() != Some("ended"))
}
pub(super) fn inspect(
    c: &Connection,
    p: &HostResourcePlan,
    host_epoch: Option<&str>,
    extra: &[ExecutionResourceScope],
) -> Result<Value, ResourceError> {
    p.check()?;
    if p.read_only {
        return Ok(json!({"allowed":true}));
    }
    let scopes = required(c, p, extra)?;
    let relax = scopes.is_empty()
        || scopes
            .iter()
            .any(|s| matches!(s, ExecutionResourceScope::File { .. }));
    let primary = primary(p, true).ok().flatten();
    let current = claims(c, None)?;
    for resource in resource_set(p, &scopes)? {
        for claim in &current {
            let reference = text(&claim["resourceRef"])?;
            if !scopes::resource_conflicts(reference, &resource.resource_ref) {
                continue;
            }
            if same(&claim["execution"], &p.execution) {
                if host_epoch.is_some_and(|host| claim["hostEpoch"].as_str() != Some(host)) {
                    return Ok(
                        json!({"allowed":false,"blocker":{"kind":"recovery","code":"execution_resource_owner_changed","resourceRef":resource.resource_ref}}),
                    );
                }
                if !matches!(claim["state"].as_str(), Some("draining" | "reconciling"))
                    && (reference != resource.resource_ref
                        || claim["identity"].as_str() == Some(&resource.identity))
                {
                    continue;
                }
            }
            if relax
                && primary
                    .as_ref()
                    .is_some_and(|r| r.resource_ref == resource.resource_ref)
                && reference.starts_with("file:")
                && matches!(claim["state"].as_str(), Some("draining" | "reconciling"))
            {
                continue;
            }
            return Ok(json!({"allowed":false,"blocker":blocker(claim)}));
        }
    }
    Ok(json!({"allowed":true}))
}
impl ExecutionResourceStore {
    pub fn inspect(
        &self,
        p: &HostResourcePlan,
        host_epoch: Option<&str>,
    ) -> Result<Value, ResourceError> {
        self.read(|c| inspect(c, p, host_epoch, &[]))
    }
    pub fn reserve(
        &mut self,
        p: &HostResourcePlan,
        request: ResourceReservation<'_>,
        at: &str,
    ) -> Result<Value, ResourceError> {
        p.check()?;
        stamp(at)?;
        if p.read_only {
            return Ok(json!({"allowed":true}));
        }
        if request.host_epoch.is_empty() {
            return Ok(
                json!({"allowed":false,"blocker":{"kind":"recovery","code":"execution_resource_owner_unknown"}}),
            );
        }
        if request.host_epoch.len() > 8192 {
            return Err(ResourceError::Invalid);
        }
        self.transaction(|c| {
            let scopes = required(c, p, request.scopes)?;
            let decision = inspect(c, p, Some(request.host_epoch), &scopes)?;
            if decision["allowed"] != true {
                if request.record_conflict {
                    resource_set(p, &scopes)?;
                    c.execute(
                        "INSERT OR REPLACE INTO requirements VALUES(?,?)",
                        rusqlite::params![
                            p.execution.plan_id,
                            super::sql_json(
                                &json!({"execution":execution_json(&p.execution),"scopes":scopes})
                            )?
                        ],
                    )?;
                }
                return Ok(decision);
            }
            let mut result = Vec::new();
            for resource in resource_set(p, &scopes)? {
                let mut claim = owned(p, &resource, request.host_epoch, at)?;
                if let Some(previous) = claims(c, Some(text(&claim["claimId"])?))?.pop() {
                    if previous.get("closureId").is_some() {
                        return Err(ResourceError::ClaimClosed);
                    }
                    if previous["state"] != "released" {
                        result.push(previous);
                        continue;
                    }
                    claim["revision"] = next_revision(&previous)?;
                }
                put_claim(c, &claim)?;
                result.push(claim);
            }
            Ok(json!({"allowed":true,"claims":result}))
        })
    }
    pub fn snapshot(&self) -> Result<Vec<Value>, ResourceError> {
        self.read(|c| claims(c, None))
    }
    pub fn claims_for(&self, p: &HostResourcePlan) -> Result<Vec<Value>, ResourceError> {
        p.check()?;
        Ok(self
            .snapshot()?
            .into_iter()
            .filter(|c| same(&c["execution"], &p.execution))
            .collect())
    }
    pub fn has_claim(&self, p: &HostResourcePlan) -> Result<bool, ResourceError> {
        Ok(!self.claims_for(p)?.is_empty())
    }
    pub fn has_closure(&self, p: &HostResourcePlan) -> Result<bool, ResourceError> {
        p.check()?;
        self.read(|c| database::has_closure(c, p))
    }
    pub fn admitted(&self, p: &HostResourcePlan, host_epoch: &str) -> Result<bool, ResourceError> {
        p.check()?;
        if p.read_only {
            return Ok(true);
        }
        let primary = primary(p, false)?.ok_or(ResourceError::Scope)?;
        Ok(self.claims_for(p)?.iter().any(|c| {
            c["hostEpoch"].as_str() == Some(host_epoch)
                && c["resourceRef"].as_str() == Some(&primary.resource_ref)
                && c["identity"].as_str() == Some(&primary.identity)
                && matches!(c["state"].as_str(), Some("reserved" | "active"))
        }))
    }
    pub fn activate(
        &mut self,
        p: &HostResourcePlan,
        host_epoch: &str,
        at: &str,
    ) -> Result<bool, ResourceError> {
        p.check()?;
        stamp(at)?;
        if p.read_only {
            return Ok(true);
        }
        self.transaction(|c| {
            let claims = claims(c, None)?
                .into_iter()
                .filter(|v| same(&v["execution"], &p.execution))
                .collect::<Vec<_>>();
            let primary = primary(p, false)?.ok_or(ResourceError::Scope)?;
            if !claims
                .iter()
                .any(|v| v["resourceRef"].as_str() == Some(&primary.resource_ref))
            {
                return Ok(false);
            }
            for claim in &claims {
                if claim["hostEpoch"].as_str() != Some(host_epoch)
                    || !matches!(claim["state"].as_str(), Some("reserved" | "active"))
                {
                    return Ok(false);
                }
                let scope = scopes::scope_for_ref(text(&claim["resourceRef"])?)
                    .ok_or(ResourceError::Scope)?;
                let actual = if scope["kind"] == "file" {
                    scopes::file_resource(text(&scope["path"])?, true)?
                } else {
                    scopes::directory_resource(text(&scope["path"])?, false)?
                };
                if claim["identity"].as_str() != Some(&actual.identity) {
                    return Ok(false);
                }
            }
            for mut claim in claims {
                if claim["state"] != "active" {
                    claim["revision"] = next_revision(&claim)?;
                    claim["state"] = "active".into();
                    claim["updatedAt"] = at.into();
                    put_claim(c, &claim)?;
                }
            }
            Ok(true)
        })
    }
    pub fn protect(
        &mut self,
        p: &HostResourcePlan,
        host_epoch: Option<&str>,
        operation_id: Option<&str>,
        state: &str,
        evidence: &[String],
        at: &str,
    ) -> Result<(), ResourceError> {
        p.check()?;
        stamp(at)?;
        if p.read_only {
            return Ok(());
        }
        if !matches!(state, "draining" | "reconciling") || evidence.len() > 4096 {
            return Err(ResourceError::Invalid);
        }
        super::borrowed_ids(evidence)?;
        self.transaction(|c| {
            if database::has_closure(c, p)? {
                return Ok(());
            }
            let resource = primary(p, true)?.ok_or(ResourceError::Scope)?;
            let mut next = owned(p, &resource, host_epoch.unwrap_or(""), at)?;
            if host_epoch.is_none() {
                next.as_object_mut().unwrap().remove("hostEpoch");
            }
            let mut current = claims(c, None)?
                .into_iter()
                .filter(|v| same(&v["execution"], &p.execution))
                .collect::<Vec<_>>();
            if !current.iter().any(|v| v["claimId"] == next["claimId"]) {
                current.push(
                    claims(c, Some(text(&next["claimId"])?))?
                        .pop()
                        .unwrap_or(next),
                );
            }
            for mut old in current {
                if old["state"] == state
                    && old.get("operationId").and_then(Value::as_str) == operation_id
                    && old["evidenceCalls"] == json!(evidence)
                {
                    continue;
                }
                let mut calls = ids(&old["evidenceCalls"])?;
                for id in evidence {
                    if !calls.contains(id) {
                        calls.push(id.clone());
                    }
                }
                old["revision"] = next_revision(&old)?;
                old["state"] = state.into();
                old["evidenceCalls"] = json!(calls);
                old["updatedAt"] = at.into();
                if let Some(op) = operation_id {
                    old["operationId"] = op.into();
                } else {
                    old.as_object_mut().unwrap().remove("operationId");
                }
                put_claim(c, &old)?;
            }
            Ok(())
        })
    }
    pub fn mark_handle(
        &mut self,
        p: &HostResourcePlan,
        handle: &Value,
        at: &str,
    ) -> Result<(), ResourceError> {
        p.check()?;
        stamp(at)?;
        if p.read_only {
            return Ok(());
        }
        let id = text(&handle["handleId"])?;
        text(&handle["toolCallId"])?;
        super::sql_json(handle)?;
        if !matches!(
            handle["state"].as_str(),
            Some("active" | "ended" | "unknown")
        ) {
            return Err(ResourceError::Invalid);
        }
        self.transaction(|c| {
            let claims = claims(c, None)?
                .into_iter()
                .filter(|v| same(&v["execution"], &p.execution))
                .collect::<Vec<_>>();
            if claims.is_empty() {
                return Err(ResourceError::OwnerUnknown);
            }
            for mut claim in claims {
                let mut handles = claim
                    .get("handles")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if !handles.contains_key(id) && handles.len() >= 1024 {
                    return Err(ResourceError::Limit);
                }
                handles.insert(id.into(), handle.clone());
                claim["handles"] = Value::Object(handles);
                claim["revision"] = next_revision(&claim)?;
                claim["updatedAt"] = at.into();
                put_claim(c, &claim)?;
            }
            Ok(())
        })
    }
    pub fn unsettled_handles(&self, p: &HostResourcePlan) -> Result<Vec<Value>, ResourceError> {
        Ok(self
            .claims_for(p)?
            .iter()
            .flat_map(open_handles)
            .cloned()
            .collect())
    }
}
