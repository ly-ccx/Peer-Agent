//! One owned MCP session; each queued request carries its own live Host port.
use super::*;
use crate::{
    mcp::{Connection, McpPeer},
    mcp_auth::SensitiveConfig,
};
use std::sync::atomic::Ordering;

pub(super) struct Request {
    pub args: Value,
    pub name: String,
    pub port: EffectAdmission,
    pub reply: oneshot::Sender<EffectOutcome>,
}
pub(super) struct Session {
    pub config: Value,
    pub home: PathBuf,
    pub credentials: crate::mcp_oauth::CredentialEpoch,
    pub server: String,
    pub handle: String,
    pub owner: Recorder,
    pub receiver: mpsc::Receiver<Request>,
}
struct Connected {
    peer: McpPeer,
    connection: Connection,
    config: SensitiveConfig,
}
impl Session {
    pub async fn run(mut self, cancel: CancellationToken) -> Result<(), ()> {
        let mut active: Option<Connected> = None;
        let mut protection = crate::mcp::Protection::default();
        let mut ended = true;
        loop {
            let request = tokio::select! {biased;
                _=cancel.cancelled()=>break,
                _=async{active.as_ref().unwrap().peer.state.stopped().await},if active.is_some()=>break,
                request=self.receiver.recv()=>match request{Some(request)=>request,None=>break},
            };
            let outcome = self
                .execute(&request, &mut active, &cancel, &mut protection)
                .await;
            let fatal = outcome.error == Some("execution_outcome_unknown")
                || outcome.error == Some("mcp_stop_unproven")
                || outcome.error == Some("mcp_network_protection_limit");
            ended &= outcome.error != Some("mcp_stop_unproven");
            let _ = request.reply.send(outcome);
            if fatal {
                break;
            }
        }
        self.receiver.close();
        while let Some(request) = self.receiver.recv().await {
            let _ = request
                .reply
                .send(EffectOutcome::not_dispatched(if cancel.is_cancelled() {
                    "CANCELLED"
                } else {
                    "mcp_connection_closed"
                }));
        }
        if let Some(active) = active {
            ended &= active.connection.close().await.is_ok();
        }
        if ended { Ok(()) } else { Err(()) }
    }
    async fn execute(
        &self,
        request: &Request,
        active: &mut Option<Connected>,
        cancel: &CancellationToken,
        protection: &mut crate::mcp::Protection,
    ) -> EffectOutcome {
        let ready = self.ready(request, active, cancel, protection).await;
        if let Err(code) = ready {
            return EffectOutcome::not_dispatched(code);
        }
        let active = active.as_ref().unwrap();
        active.peer.state.sent.store(false, Ordering::Release);
        if let Err(code) = request.port.check().await {
            return EffectOutcome::not_dispatched(code.0);
        }
        let binding = match self.credentials.binding(&self.config) {
            Ok(b) => b,
            Err(code) => return EffectOutcome::not_dispatched(code),
        };
        if let Err(code) = crate::mcp_auth::check_access(&self.home, binding.as_ref()) {
            return EffectOutcome::not_dispatched(code);
        }
        let result = active
            .peer
            .call(request.name.clone(), request.args.clone(), cancel)
            .await
            .and_then(|raw| active.peer.state.prepare_result(raw, &active.config.0));
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
                let sent = active.peer.state.sent.load(Ordering::Acquire);
                let unknown = sent && code != "mcp_tool_error";
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
                    not_dispatched: !sent,
                }
            }
        }
    }
    async fn ready(
        &self,
        request: &Request,
        active: &mut Option<Connected>,
        cancel: &CancellationToken,
        protection: &mut crate::mcp::Protection,
    ) -> Result<(), &'static str> {
        request.port.check().await.map_err(|e| e.0)?;
        let mut binding = self.credentials.binding(&self.config)?;
        let mut config =
            crate::mcp_auth::resolve(&self.home, self.config.clone(), binding.as_ref(), cancel)
                .await;
        if matches!(config, Err("mcp_oauth_refresh_required")) {
            if let Some(old) = active.as_ref() {
                *protection = old.peer.state.retain_protection(&old.config.0)?;
            }
            // An old token is never left live while its replacement is exchanged.
            if let Some(old) = active.take() {
                old.connection
                    .close()
                    .await
                    .map_err(|_| "mcp_stop_unproven")?;
            }
            let secrets = crate::mcp_oauth::refresh_runtime(
                &self.home,
                &self.server,
                binding.as_ref().ok_or("mcp_oauth_binding_required")?,
                &self.credentials,
                &request.port,
                cancel,
            )
            .await?;
            protection.extend(&secrets)?;
            binding = self.credentials.binding(&self.config)?;
            config =
                crate::mcp_auth::resolve(&self.home, self.config.clone(), binding.as_ref(), cancel)
                    .await;
        }
        let config = config?;
        request.port.check().await.map_err(|e| e.0)?;
        crate::mcp_auth::check_access(&self.home, binding.as_ref())?;
        if active.is_none() {
            let (peer, connection) =
                Connection::open(&config.0, cancel, &request.port, &self.handle, &self.owner)
                    .await?;
            *active = Some(Connected {
                peer,
                connection,
                config,
            });
        }
        active
            .as_ref()
            .unwrap()
            .peer
            .state
            .protect(protection.values())?;
        Ok(())
    }
}
