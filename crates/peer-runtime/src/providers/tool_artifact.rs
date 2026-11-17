//! Immutable result retrieval uses the same live Host admission as file reads.
use super::*;
use peer_store::{ToolArtifactRef, ToolArtifactStore};
pub(super) struct ToolArtifactProvider;
struct ReadArtifact {
    args: Value,
    reference: ToolArtifactRef,
    home: PathBuf,
    offset: u64,
    length: usize,
    port: Option<EffectAdmission>,
}
impl CapabilityProvider for ToolArtifactProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/tool-artifacts.json"
        ))
        .expect("compiled artifact manifest");
        vec![("read_tool_result".into(), v["readerManifest"].clone())]
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != "local.tool-result.read" {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(&args, &["reference", "offset", "length"])?;
        let reference: ToolArtifactRef = serde_json::from_value(args["reference"].clone())
            .map_err(|_| HostError("artifact_invalid"))?;
        let offset = match args.get("offset") {
            None => 0,
            Some(v) => v.as_u64().ok_or(HostError("artifact_invalid"))?,
        };
        let length = match args.get("length") {
            None => 4096,
            Some(v) => v
                .as_u64()
                .filter(|n| *n > 0 && *n <= 262144)
                .ok_or(HostError("artifact_invalid"))? as usize,
        };
        Ok(Box::new(ReadArtifact {
            args,
            reference,
            home: home.into(),
            offset,
            length,
            port: None,
        }))
    }
}
impl PreparedEffect for ReadArtifact {
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }
    fn start(
        mut self: Box<Self>,
        host: &mut NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        host.validate_permission(grant, &self.args, now)?;
        let conversation = grant.conversation_id().to_owned();
        if self.reference.conversation_id != conversation {
            return Ok(Box::pin(async {
                EffectOutcome::not_dispatched("artifact_invalid")
            }));
        }
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            let runtime = tokio::runtime::Handle::current();
            let task = tokio::task::spawn_blocking(move || -> Result<Value, HostError> {
                runtime.block_on(port.check())?;
                let w = ToolArtifactStore::new(&self.home)
                    .read_window(
                        &conversation,
                        &self.reference,
                        self.offset,
                        self.length,
                        &|| cancel.is_cancelled(),
                    )
                    .map_err(|e| {
                        HostError(if e == peer_store::ToolArtifactError::Cancelled {
                            "CANCELLED"
                        } else {
                            e.code()
                        })
                    })?;
                let bytes = match std::str::from_utf8(&w.bytes) {
                    Ok(_) => w.bytes.as_slice(),
                    Err(e) if e.error_len().is_none() => &w.bytes[..e.valid_up_to()],
                    Err(_) => return Err(HostError("artifact_invalid")),
                };
                let content =
                    std::str::from_utf8(bytes).map_err(|_| HostError("artifact_invalid"))?;
                if !w.bytes.is_empty() && bytes.is_empty() {
                    return Err(HostError("artifact_invalid"));
                }
                runtime.block_on(port.check())?;
                Ok(
                    json!({"content":content,"nativeContentRef":self.reference,"offset":w.offset,"bytes":bytes.len(),"totalBytes":w.total_bytes,"complete":w.complete&&bytes.len()==w.bytes.len()}),
                )
            });
            match task.await {
                Ok(Ok(output)) => EffectOutcome {
                    status: "success",
                    output,
                    error: None,
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                },
                Ok(Err(e)) => {
                    let mut out = EffectOutcome::failed(e.0);
                    if e.0 == "CANCELLED" {
                        out.status = "cancelled";
                    }
                    out
                }
                Err(_) => EffectOutcome::failed("artifact_unavailable"),
            }
        }))
    }
}
