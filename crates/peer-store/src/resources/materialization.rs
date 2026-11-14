use super::{
    ExecutionResourceStore, HostFileMaterialization, HostResourcePlan, ResourceError,
    claims::{claims, owned},
    database::{has_closure, put_claim, same},
    file_resource, ids, next_revision, stamp, text,
};

impl ExecutionResourceStore {
    /// Confirm only a missing -> actually-created inode transition. Existing
    /// inode changes, other owners and protected/closed claims stay fenced.
    pub fn confirm_file_materialization(
        &mut self,
        plan: &HostResourcePlan,
        receipt: HostFileMaterialization<'_>,
        at: &str,
    ) -> Result<bool, ResourceError> {
        plan.check()?;
        stamp(at)?;
        if plan.read_only
            || receipt.host_epoch.is_empty()
            || receipt.host_epoch.len() > 8192
            || !crate::valid_id(receipt.tool_call_id, true)
        {
            return Err(ResourceError::Invalid);
        }
        let path = receipt
            .identity
            .resource_ref
            .strip_prefix("file:")
            .ok_or(ResourceError::Scope)?;
        let expected = owned(plan, receipt.identity, receipt.host_epoch, at)?;
        self.transaction(|c| {
            if has_closure(c, plan)? {
                return Err(ResourceError::ClaimClosed);
            }
            let mut claim = claims(c, Some(text(&expected["claimId"])?))?
                .pop()
                .ok_or(ResourceError::ClaimMissing)?;
            if !same(&claim["execution"], &plan.execution)
                || claim["workspaceId"] != plan.workspace_id
                || claim["hostEpoch"].as_str() != Some(receipt.host_epoch)
                || claim["resourceRef"].as_str() != Some(&receipt.identity.resource_ref)
            {
                return Err(ResourceError::OwnerUnknown);
            }
            if claim.get("closureId").is_some() {
                return Err(ResourceError::ClaimClosed);
            }
            if !matches!(claim["state"].as_str(), Some("reserved" | "active"))
                || !ids(&claim["evidenceCalls"])?.is_empty()
            {
                return Err(ResourceError::ClaimActive);
            }
            // Observe again while holding the ledger transaction. The Provider
            // already compared this identity with its owned file descriptor.
            if file_resource(path, false)? != *receipt.identity {
                return Err(ResourceError::Changed);
            }
            if claim["identity"].as_str() == Some(&receipt.identity.identity) {
                return Ok(false);
            }
            if claim["identity"] != "missing" {
                return Err(ResourceError::Changed);
            }
            claim["identity"] = receipt.identity.identity.clone().into();
            claim["revision"] = next_revision(&claim)?;
            claim["updatedAt"] = at.into();
            put_claim(c, &claim)?;
            c.execute(
                "INSERT INTO resource_events(resource,operationId) VALUES(?,?)",
                [
                    &receipt.identity.resource_ref,
                    &format!("tool-result://{}", receipt.tool_call_id),
                ],
            )?;
            Ok(true)
        })
    }
}
