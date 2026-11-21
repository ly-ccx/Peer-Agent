//! MCP Adapter at the same Provider/Projection/Grant seam as native file/Shell.
use super::*;
use crate::{effect_admission::native_mcp_metadata, recorder::Recorder};
use peer_store::{McpRegistrySnapshot, McpRegistryStore};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{Mutex, mpsc, oneshot};
mod session;
struct Cell {
    requests: mpsc::Sender<session::Request>,
}
pub(super) struct McpProvider {
    manifests: Vec<Value>,
    configs: HashMap<String, Value>,
    credentials: crate::mcp_oauth::CredentialEpoch,
    revision: String,
    owner: Recorder,
    pool: Arc<Mutex<HashMap<String, Arc<Cell>>>>,
}
impl McpProvider {
    pub fn new(
        snapshot: &McpRegistrySnapshot,
        owner: &Value,
        _home: &Path,
        credentials: crate::mcp_oauth::CredentialEpoch,
    ) -> Result<Self, HostError> {
        let owner: Recorder = serde_json::from_value(owner["recorder"].clone())
            .map_err(|_| HostError("native_recorder_unavailable"))?;
        let mut configs = HashMap::new();

        for manifest in &snapshot.inventory.manifests {
            let id = manifest["providerId"]
                .as_str()
                .ok_or(HostError("mcp_config_invalid"))?;
            if configs.contains_key(id) {
                continue;
            }
            let mut config = snapshot.server(id).ok_or(HostError("mcp_config_invalid"))?;
            config["transport"] = manifest["origin"]["transport"].clone();
            credentials.binding(&config).map_err(HostError)?;
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
            credentials,
            revision: snapshot.source_revision.clone(),
            owner,
            pool: Arc::new(Mutex::new(HashMap::new())),
        })
    }
}
struct McpEffect {
    args: Value,
    config: Value,
    credentials: crate::mcp_oauth::CredentialEpoch,
    metadata: Value,
    revision: String,
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
            credentials: self.credentials.clone(),
            metadata: json!({"evidenceKind":"local_mcp_tool_call","serverId":id,"providerId":id,"transport":manifest["origin"]["transport"],"toolName":manifest["origin"]["toolName"]}),
            revision: self.revision.clone(),
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
        _call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        if McpRegistryStore::new(&self.home).read()?.source_revision != self.revision {
            return Err(HostError("native_capability_inventory_changed"));
        }
        self.credentials.check().map_err(HostError)?;
        let port = self
            .port
            .clone()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            if let Err(error) = port.check().await {
                return EffectOutcome::not_dispatched(error.0);
            }
            let server = self.metadata["serverId"].as_str().unwrap().to_owned();
            let cell = {
                let mut pool = tokio::select! { biased;
                    _=cancel.cancelled()=>return EffectOutcome::not_dispatched("CANCELLED"),
                    pool=self.pool.lock()=>pool,
                };
                if let Some(cell) = pool.get(&server) {
                    cell.clone()
                } else {
                    if pool.len() >= crate::mcp::LIMITS["maxConnections"].as_u64().unwrap() as usize
                    {
                        return EffectOutcome::not_dispatched("mcp_connection_limit");
                    }
                    let (sender, receiver) = mpsc::channel(8);
                    let cell = Arc::new(Cell { requests: sender });
                    let handle = format!("mcp-connection-{}", uuid::Uuid::new_v4());
                    let session = session::Session {
                        config: self.config.clone(),
                        home: self.home.clone(),
                        credentials: self.credentials.clone(),
                        server: server.clone(),
                        handle: handle.clone(),
                        owner: self.owner.clone(),
                        receiver,
                    };
                    let owned = cancel.child_token();
                    let metadata = native_mcp_metadata(
                        self.metadata["transport"].as_str().unwrap(),
                        &self.revision,
                        &json!(self.owner),
                        "connection",
                    );
                    #[cfg(feature = "test-fixtures")]
                    let metadata = {
                        let mut metadata = metadata;
                        if self.home.join(".native-cli-fixture").is_file() {
                            match std::env::var("PEER_NATIVE_CONNECTION_FAULT").as_deref() {
                                Ok("owner") => {
                                    metadata["ownerRecorder"]["hostId"] =
                                        json!("fixture-wrong-owner")
                                }
                                Ok("owner-start") => {
                                    metadata["ownerRecorder"]["pidStart"] =
                                        json!("fixture-wrong-start")
                                }
                                Ok("owner-boot") => {
                                    metadata["ownerRecorder"]["bootId"] =
                                        json!("fixture-wrong-boot")
                                }
                                Ok("role") => metadata["role"] = json!("tool"),
                                Ok("transport") => metadata["transport"] = json!("unsupported"),
                                Ok("known-transport") => metadata["transport"] = json!("sse"),
                                Ok("revision") => metadata["registryRevision"] = json!("changed"),
                                _ => (),
                            }
                        }
                        metadata
                    };
                    if let Err(error) = port
                        .connection(
                            handle,
                            metadata,
                            owned.clone(),
                            Box::pin(session.run(owned)),
                        )
                        .await
                    {
                        return EffectOutcome::not_dispatched(error.0);
                    }
                    pool.insert(server, cell.clone());
                    cell
                }
            };
            let (reply, receive) = oneshot::channel();
            let request = session::Request {
                args: self.args.clone(),
                name: self.metadata["toolName"].as_str().unwrap().to_owned(),
                port,
                reply,
            };
            tokio::select! {biased;
                _=cancel.cancelled()=>return EffectOutcome::not_dispatched("CANCELLED"),
                sent=cell.requests.send(request)=>if sent.is_err(){return EffectOutcome::not_dispatched("mcp_connection_closed")},
            }
            // Once queued, only its owner can report whether this request was sent.
            // Cancellation still reaches that owner through the attempt token.
            receive
                .await
                .unwrap_or_else(|_| EffectOutcome::failed("execution_outcome_unknown"))
        }))
    }
}
