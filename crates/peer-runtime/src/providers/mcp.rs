//! MCP Adapter at the same Provider/Projection/Grant seam as native file/Shell.
use super::*;
use crate::{
    effect_admission::native_mcp_metadata,
    mcp::{Connection, McpPeer},
    recorder::Recorder,
};
use peer_store::{HostResourcePlan, McpRegistrySnapshot, McpRegistryStore};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::Ordering},
};
use tokio::sync::watch;

#[derive(Clone)]
enum Ready {
    Starting,
    Connected(McpPeer, Arc<crate::mcp_auth::SensitiveConfig>),
    Failed(&'static str),
}
struct Cell {
    ready: watch::Sender<Ready>,
}
pub(super) struct McpProvider {
    manifests: Vec<Value>,
    configs: HashMap<String, Value>,
    bindings: HashMap<String, Option<peer_store::McpCredentialBinding>>,
    revision: String,
    resource: HostResourcePlan,
    owner: Recorder,
    pool: Arc<Mutex<HashMap<String, Arc<Cell>>>>,
}
impl McpProvider {
    pub fn new(
        snapshot: &McpRegistrySnapshot,
        resource: &HostResourcePlan,
        owner: &Value,
        home: &Path,
    ) -> Result<Self, HostError> {
        let owner: Recorder = serde_json::from_value(owner["recorder"].clone())
            .map_err(|_| HostError("native_recorder_unavailable"))?;
        let mut configs = HashMap::new();
        let mut bindings = HashMap::new();
        for manifest in &snapshot.inventory.manifests {
            let id = manifest["providerId"]
                .as_str()
                .ok_or(HostError("mcp_config_invalid"))?;
            if configs.contains_key(id) {
                continue;
            }
            let mut config = snapshot.server(id).ok_or(HostError("mcp_config_invalid"))?;
            config["transport"] = manifest["origin"]["transport"].clone();
            bindings.insert(
                id.into(),
                crate::mcp_auth::binding(home, &config).map_err(HostError)?,
            );
            if let Some(args) = config["args"].as_array()
                && (args.len() > 1024
                    || args.iter().any(|v| {
                        v.as_str()
                            .is_none_or(|s| s.len() > 16384 || s.contains('\0'))
                    }))
            {
                return Err(HostError("mcp_config_invalid"));
            }
            match config["transport"].as_str() {
                Some("stdio") => {
                    if config["command"]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.contains('\0'))
                    {
                        return Err(HostError("mcp_command_invalid"));
                    }
                }
                _ => {
                    let raw = config["url"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| config["serverUrl"].as_str())
                        .ok_or(HostError("mcp_url_invalid"))?;
                    let url = reqwest::Url::parse(raw).map_err(|_| HostError("mcp_url_invalid"))?;
                    if !matches!(url.scheme(), "http" | "https")
                        || !url.username().is_empty()
                        || url.password().is_some()
                    {
                        return Err(HostError("mcp_url_invalid"));
                    }
                }
            }
            configs.insert(id.into(), config);
        }
        Ok(Self {
            manifests: snapshot.inventory.manifests.clone(),
            configs,
            bindings,
            revision: snapshot.source_revision.clone(),
            resource: resource.clone(),
            owner,
            pool: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}
struct McpEffect {
    args: Value,
    config: Value,
    binding: Option<peer_store::McpCredentialBinding>,
    metadata: Value,
    revision: String,
    resource: HostResourcePlan,
    owner: Recorder,
    pool: Arc<Mutex<HashMap<String, Arc<Cell>>>>,
    port: Option<EffectAdmission>,
    handle: String,
    home: PathBuf,
}
impl CapabilityProvider for McpProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        self.manifests
            .iter()
            .map(|m| (m["name"].as_str().unwrap().into(), m.clone()))
            .collect()
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        let manifest = self
            .manifests
            .iter()
            .find(|m| m["capabilityId"] == capability)
            .ok_or(HostError("tool_not_projected"))?;
        if !args.is_object()
            || serde_json::to_vec(&args)
                .map_err(|_| HostError("tool_arguments_invalid"))?
                .len()
                > 262144
        {
            return Err(HostError("tool_arguments_invalid"));
        }
        let id = manifest["providerId"].as_str().unwrap();
        let config = self.configs[id].clone();
        Ok(Box::new(McpEffect {
            args,
            config,
            binding: self.bindings[id].clone(),
            metadata: json!({"evidenceKind":"local_mcp_tool_call","serverId":id,"providerId":id,"transport":manifest["origin"]["transport"],"toolName":manifest["origin"]["toolName"]}),
            revision: self.revision.clone(),
            resource: self.resource.clone(),
            owner: self.owner.clone(),
            pool: self.pool.clone(),
            port: None,
            handle: format!("mcp-call-{}", uuid::Uuid::new_v4()),
            home: home.into(),
        }))
    }
}
impl PreparedEffect for McpEffect {
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port)
    }
    fn evidence(&self) -> Option<Value> {
        Some(self.metadata.clone())
    }
    fn projection(&mut self, id: &str) {
        self.metadata["projectionId"] = json!(id)
    }
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Mcp
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }
    fn handle_metadata(&self) -> Option<Value> {
        Some(native_mcp_metadata(
            self.metadata["transport"].as_str().unwrap(),
            &self.revision,
            &json!(self.owner),
            "rpc",
        ))
    }
    fn handle(&self) -> Option<&str> {
        Some(&self.handle)
    }
    fn start(
        self: Box<Self>,
        host: &mut NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        host.validate_permission(grant, &self.args, now)?;
        if McpRegistryStore::new(&self.home).read()?.source_revision != self.revision {
            return Err(HostError("native_capability_inventory_changed"));
        }
        crate::mcp_auth::check(&self.home, self.binding.as_ref()).map_err(HostError)?;
        let port = self
            .port
            .clone()
            .ok_or(HostError("execution_admission_closed"))?;
        let server = self.metadata["serverId"].as_str().unwrap().to_owned();
        let cell = {
            let mut pool = self
                .pool
                .lock()
                .map_err(|_| HostError("mcp_pool_unavailable"))?;
            if let Some(cell) = pool.get(&server) {
                cell.clone()
            } else {
                if pool.len() >= crate::mcp::LIMITS["maxConnections"].as_u64().unwrap() as usize {
                    return Err(HostError("mcp_connection_limit"));
                }
                let (sender, _) = watch::channel(Ready::Starting);
                let cell = Arc::new(Cell { ready: sender });
                let handle = format!("mcp-connection-{}", uuid::Uuid::new_v4());
                let call = grant.facts()["toolCallId"]
                    .as_str()
                    .ok_or(HostError("access_identity_invalid"))?
                    .to_owned();
                host.resources.mark_handle(&self.resource,&json!({"handleId":handle,"toolCallId":call,"state":"active","nativeMcp":native_mcp_metadata(self.metadata["transport"].as_str().unwrap(),&self.revision,&json!(self.owner),"connection")}),now)?;
                let owned_handle = handle.clone();
                let (config, owner, port, ready, owned, home, binding) = (
                    self.config.clone(),
                    self.owner.clone(),
                    port.clone(),
                    cell.ready.clone(),
                    cancel.clone(),
                    self.home.clone(),
                    self.binding.clone(),
                );
                let slot = host.live.track_handle(
                    &self.resource.execution,
                    &handle.clone(),
                    &call,
                    cancel.clone(),
                    async move {
                        let resolved = async {
                            let config = Arc::new(
                                crate::mcp_auth::resolve(&home, config, binding.as_ref(), &owned)
                                    .await?,
                            );
                            port.check().await.map_err(|e| e.0)?;
                            crate::mcp_auth::check_access(&home, binding.as_ref())?;
                            let (peer, connection) =
                                Connection::open(&config.0, &owned, &port, &owned_handle, &owner)
                                    .await?;
                            Ok::<_, &'static str>((peer, connection, config))
                        }
                        .await;
                        match resolved {
                            Ok((peer, connection, config)) => {
                                ready.send_replace(Ready::Connected(peer, config));
                                connection.run(owned).await
                            }
                            Err(code) => {
                                ready.send_replace(Ready::Failed(code));
                                if code == "mcp_stop_unproven" {
                                    Err(())
                                } else {
                                    Ok(())
                                }
                            }
                        }
                    },
                );
                if slot.is_err() {
                    host.resources.mark_handle(
                        &self.resource,
                        &json!({"handleId":handle,"toolCallId":call,"state":"ended"}),
                        now,
                    )?;
                    return Err(HostError("mcp_connection_owner_unavailable"));
                }
                pool.insert(server, cell.clone());
                cell
            }
        };
        Ok(Box::pin(async move {
            let mut ready = cell.ready.subscribe();
            let (peer, config) = loop {
                let state = ready.borrow().clone();
                match state {
                    Ready::Connected(peer, config) => break (peer, config),
                    Ready::Failed(code) => return EffectOutcome::not_dispatched(code),
                    Ready::Starting => {
                        tokio::select! {biased;_=cancel.cancelled()=>return EffectOutcome::not_dispatched("CANCELLED"),value=ready.changed()=>if value.is_err(){return EffectOutcome::not_dispatched("mcp_connection_closed")}}
                    }
                }
            };
            peer.state.sent.store(false, Ordering::Release);
            if let Err(code) = port.check().await {
                return EffectOutcome::not_dispatched(code.0);
            }
            if let Err(code) = crate::mcp_auth::check_access(&self.home, self.binding.as_ref()) {
                return EffectOutcome::not_dispatched(code);
            }
            let name = self.metadata["toolName"].as_str().unwrap().to_owned();
            let result = peer
                .call(name, self.args.clone(), &cancel)
                .await
                .and_then(|raw| crate::mcp::prepare_result(raw, &config.0));
            match result {
                Ok(output) => EffectOutcome {
                    status: if output["isError"] == true {
                        "failed"
                    } else {
                        "success"
                    },
                    output,
                    error: None,
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                },
                Err(code) => {
                    let unknown =
                        peer.state.sent.load(Ordering::Acquire) && code != "mcp_tool_error";
                    EffectOutcome {
                        status: if code == "CANCELLED" {
                            "cancelled"
                        } else {
                            "failed"
                        },
                        output: json!({"code":code}),
                        error: Some(if unknown {
                            "execution_outcome_unknown"
                        } else {
                            code
                        }),
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: !peer.state.sent.load(Ordering::Acquire),
                    }
                }
            }
        }))
    }
}
