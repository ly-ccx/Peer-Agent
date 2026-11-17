//! The Host owns registration before an MCP transport driver is ever polled.
use super::*;
impl NativeSessionHost {
    pub(super) fn register_connection(
        &mut self,
        authorization: &super::effect_wait::AuthorizationWait<'_>,
        handle: String,
        metadata: Value,
        cancel: crate::CancellationToken,
        driver: crate::effect_admission::ConnectionDriver,
    ) -> Result<(), HostError> {
        let identity = authorization.grant.identity();
        let lease = self.journal.lease().record();
        let current = self.current(identity.plan_id, &episode_time())?;
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .ok_or(HostError("mcp_handle_invalid"))?;
        let mut pending = current.journal.state["works"][work]["budget"]["attempts"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
            .flat_map(|a| a["pendingTools"].as_array().into_iter().flatten())
            .filter(|r| {
                r["toolCallId"] == identity.tool_call_id
                    && r["capabilityId"] == identity.capability_id
            });
        let row = pending.next().ok_or(HostError("mcp_handle_invalid"))?;
        if pending.next().is_some() {
            return Err(HostError("mcp_handle_invalid"));
        }
        let original = peer_protocol::normalize_native_episode_recorder(
            &row["nativeRecorder"],
            &authorization.resource.execution,
        )
        .ok_or(HostError("mcp_handle_invalid"))?;
        let expected: crate::recorder::Recorder =
            serde_json::from_value(original["recorder"].clone())
                .map_err(|_| HostError("mcp_handle_invalid"))?;
        let registry = peer_store::McpRegistryStore::new(&self.home).read()?;
        let manifest = registry
            .inventory
            .manifests
            .iter()
            .find(|m| m["capabilityId"] == identity.capability_id)
            .ok_or(HostError("mcp_handle_invalid"))?;
        let recorder: crate::recorder::Recorder =
            serde_json::from_value(metadata["ownerRecorder"].clone())
                .map_err(|_| HostError("mcp_handle_invalid"))?;
        if identity.permission != ProviderPermission::Mcp
            || !identity.capability_id.starts_with("local.mcp.")
            || metadata["schemaVersion"] != 1
            || metadata["role"] != "connection"
            || !matches!(
                metadata["transport"].as_str(),
                Some("stdio" | "streamable_http" | "sse")
            )
            || !recorder.complete()
            || recorder != expected
            || recorder.pid != std::process::id()
            || recorder.host_id != lease.host_id
            || recorder.acquired_at != lease.acquired_at
            || metadata["registryRevision"] != registry.source_revision
            || metadata["transport"] != manifest["origin"]["transport"]
        {
            return Err(HostError("mcp_handle_invalid"));
        }
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let resource = authorization.resource;
        self.resources.mark_handle(resource, &json!({"handleId":handle,"toolCallId":identity.tool_call_id,"state":"active","nativeMcp":metadata}), &episode_time())?;
        if self
            .live
            .track_handle(
                &resource.execution,
                &handle,
                identity.tool_call_id,
                cancel,
                driver,
            )
            .is_err()
        {
            // Registration failed before the driver could be polled/spawn.
            self.resources.mark_handle(
                resource,
                &json!({"handleId":handle,"toolCallId":identity.tool_call_id,"state":"ended"}),
                &episode_time(),
            )?;
            return Err(HostError("mcp_connection_owner_unavailable"));
        }
        Ok(())
    }
}
