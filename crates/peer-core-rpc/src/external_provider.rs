//! Reverse RPC capability provider for Desktop-only external capabilities
//! (`local.web.control.*`, `local.browser.external.*`, `local.desktop_preview.*`,
//! `local.image.*`, `local.search.aggregate`, `local.automation.propose`).
//!
//! All capabilities still flow through `ProviderRegistry::project_for_mode`,
//! `Host::authorize`, and `EffectAdmission` before any reverse `host.capability.execute`
//! call is dispatched back to the host shell.

use crate::{protocol::ExternalCapabilityManifest, server::RpcPeer};
use peer_protocol::ExecutionResourceScope;
use peer_runtime::{
    CancellationToken,
    capability::{CapabilityError as HostError, ProviderPermission, ShellRisk},
    providers::{
        CapabilityProvider, EffectAdmission, EffectFuture, EffectOutcome, PreparedEffect,
        ProviderCall, ToolOutputKind,
    },
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_EXTERNAL_ARGS_BYTES: usize = 262_144;
const EXTERNAL_CALL_TIMEOUT: Duration = Duration::from_secs(120);

pub struct ExternalRpcProvider {
    capabilities: Vec<ExternalCapabilityManifest>,
    peer: RpcPeer,
    workspace: PathBuf,
}

impl ExternalRpcProvider {
    pub fn new(
        capabilities: Vec<ExternalCapabilityManifest>,
        peer: RpcPeer,
        workspace: PathBuf,
    ) -> Self {
        Self {
            capabilities,
            peer,
            workspace,
        }
    }
}

impl CapabilityProvider for ExternalRpcProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        self.capabilities
            .iter()
            .map(|cap| {
                let mut manifest = cap.manifest.clone();
                if let Some(obj) = manifest.as_object_mut() {
                    obj.insert("capabilityId".into(), json!(cap.capability_id));
                    obj.insert("name".into(), json!(cap.alias));
                    if !obj.contains_key("description") {
                        obj.insert("description".into(), json!(""));
                    }
                    if !obj.contains_key("inputSchema") {
                        obj.insert(
                            "inputSchema".into(),
                            json!({ "type": "object", "properties": {} }),
                        );
                    }
                }
                (cap.alias.clone(), manifest)
            })
            .collect()
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        let cap = self
            .capabilities
            .iter()
            .find(|c| c.capability_id == capability)
            .ok_or(HostError("tool_not_projected"))?;
        if !args.is_object()
            || serde_json::to_vec(&args)
                .map_err(|_| HostError("tool_arguments_invalid"))?
                .len()
                > MAX_EXTERNAL_ARGS_BYTES
        {
            return Err(HostError("tool_arguments_invalid"));
        }
        let risk = cap
            .manifest
            .get("riskLevel")
            .and_then(Value::as_str)
            .and_then(ShellRisk::from_level_str)
            .unwrap_or(ShellRisk::ExternalWrite);
        Ok(Box::new(ExternalRpcEffect {
            alias: cap.alias.clone(),
            capability_id: cap.capability_id.clone(),
            args,
            risk,
            workspace: if workspace.as_os_str().is_empty() {
                self.workspace.clone()
            } else {
                workspace.to_path_buf()
            },
            peer: self.peer.clone(),
            port: None,
            projection_id: None,
        }))
    }
}

struct ExternalRpcEffect {
    alias: String,
    capability_id: String,
    args: Value,
    risk: ShellRisk,
    workspace: PathBuf,
    peer: RpcPeer,
    port: Option<EffectAdmission>,
    projection_id: Option<String>,
}

impl PreparedEffect for ExternalRpcEffect {
    fn output_kind(&self) -> ToolOutputKind {
        ToolOutputKind::Structured
    }

    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }

    fn evidence(&self) -> Option<Value> {
        Some(json!({
            "evidenceKind": "external_rpc_capability",
            "alias": self.alias,
            "capabilityId": self.capability_id,
            "projectionId": self.projection_id,
        }))
    }

    fn projection(&mut self, id: &str) {
        self.projection_id = Some(id.to_owned());
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::External
    }

    fn risk(&self) -> Option<ShellRisk> {
        Some(self.risk)
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self.port;
        let peer = self.peer;
        let alias = self.alias;
        let capability_id = self.capability_id;
        let args = self.args;
        let workspace = self.workspace;
        let conversation_id = call.conversation_id().to_owned();
        let tool_call_id = call.tool_call_id().to_owned();

        Ok(Box::pin(async move {
            let Some(port) = port else {
                return EffectOutcome::not_dispatched("execution_admission_closed");
            };
            if let Err(err) = port.check().await {
                return EffectOutcome::not_dispatched(err.0);
            }

            let params = json!({
                "toolCallId": tool_call_id,
                "capabilityId": capability_id,
                "alias": alias,
                "arguments": args,
                "conversationId": conversation_id,
                "workspacePath": workspace.to_string_lossy(),
            });

            match peer
                .call_host_with_timeout(
                    "host.capability.execute",
                    params,
                    EXTERNAL_CALL_TIMEOUT,
                    &cancel,
                )
                .await
            {
                Ok(val) => map_host_result(val),
                Err(rpc_err) => {
                    let cancelled = cancel.is_cancelled();
                    EffectOutcome {
                        status: if cancelled { "cancelled" } else { "failed" },
                        output: json!({
                            "error": rpc_err.message,
                            "code": rpc_err.code,
                            "data": rpc_err.data,
                        }),
                        error: Some(if cancelled {
                            "CANCELLED"
                        } else {
                            "external_capability_failed"
                        }),
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: false,
                    }
                }
            }
        }))
    }
}

fn map_host_result(val: Value) -> EffectOutcome {
    let status = match val
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("success")
    {
        "success" | "ok" => "success",
        "denied" => "denied",
        "cancelled" => "cancelled",
        _ => "failed",
    };

    let mut output = match val.get("output") {
        Some(v) if !v.is_null() => v.clone(),
        _ => val.clone(),
    };

    if status != "success"
        && let Some(err_val) = val.get("error").filter(|v| !v.is_null())
        && let Some(obj) = output.as_object_mut()
        && !obj.contains_key("error")
    {
        obj.insert("error".into(), err_val.clone());
    }

    let error = match status {
        "success" => None,
        "denied" => Some("permission_denied"),
        "cancelled" => Some("CANCELLED"),
        _ => Some("external_capability_failed"),
    };

    let artifacts = val
        .get("artifacts")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .take(64)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    EffectOutcome {
        status,
        output,
        error,
        artifacts,
        ended: true,
        materialization: None,
        not_dispatched: false,
    }
}
