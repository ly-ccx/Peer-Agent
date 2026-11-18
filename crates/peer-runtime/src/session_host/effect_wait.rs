//! Ownership heartbeat and fresh dispatch authorization share the control lane.
use super::*;
use crate::{CancellationToken, effect_admission::AdmissionRequest};
use std::{future::Future, time::Duration};
use tokio::sync::mpsc;
pub(super) struct AuthorizationWait<'a> {
    pub receiver: &'a mut mpsc::Receiver<AdmissionRequest>,
    pub grant: &'a HostPermissionGrant,
    pub args: &'a Value,
    pub resource: &'a HostResourcePlan,
    pub input: &'a mut dyn PermissionInput,
    pub reads: Option<&'a mut super::read_scope::ReadScopes>,
    pub command: Option<&'a super::command_process::CommandOwner<'a>>,
    pub hooks: Option<&'a peer_store::HookConfig>,
}
pub(super) struct EffectHost<'a> {
    pub grant: &'a HostPermissionGrant,
    pub resource: &'a HostResourcePlan,
    pub input: &'a mut dyn PermissionInput,
    pub reads: Option<&'a mut super::read_scope::ReadScopes>,
    pub budget: &'a crate::execution_budget::EpisodeBudget,
    pub dispatch: &'a str,
    pub hooks: Option<&'a peer_store::HookConfig>,
}
impl NativeSessionHost {
    pub(super) async fn wait_effect<F: Future>(
        &mut self,
        future: F,
        owned: &CancellationToken,
        external: &CancellationToken,
        mut authorization: Option<AuthorizationWait<'_>>,
    ) -> Result<F::Output, HostError> {
        tokio::pin!(future);
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.tick().await;
        let mut cancelled = false;
        let at = milliseconds(&episode_time())?;
        let mut lost = !self.journal.lease().holds().unwrap_or(false)
            || self.journal.lease().takeover_requested().unwrap_or(true);
        if !lost
            && at.saturating_sub(milliseconds(&self.journal.lease().record().heartbeat_at)?) >= 5000
        {
            lost = self.journal.heartbeat(at).is_err();
        }
        if lost {
            owned.cancel();
        }
        loop {
            tokio::select! {biased;
                _=external.cancelled(),if !cancelled=>{owned.cancel();cancelled=true},
                _=tick.tick()=>{if !self.journal.lease().holds().unwrap_or(false)||self.journal.lease().takeover_requested().unwrap_or(true)||self.journal.heartbeat(milliseconds(&episode_time())?).is_err(){lost=true;owned.cancel();}},
                request=async{authorization.as_mut().unwrap().receiver.recv().await},if authorization.is_some()=>{
                    if let Some(request)=request {
                        #[cfg(feature="test-fixtures")]
                        if self.home.join(".native-cli-fixture").is_file() && std::env::var("PEER_NATIVE_AUTH_CONTROL_BARRIER").as_deref()==Ok("slow") {
                            // A controlled expensive synchronous validator; the
                            // signal registration and watcher code stay unchanged.
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        // Several workers can keep this receiver continuously
                        // ready. A cooperative budget can then cover many slow
                        // synchronous authority reads before the signal watcher
                        // runs. Yield per control request, then propagate the
                        // latest cancellation before issuing its reply.
                        tokio::task::yield_now().await;
                        if external.is_cancelled() { owned.cancel();cancelled=true; }
                        let a=authorization.as_ref().unwrap();
                        let valid=if lost{Err(HostError("HOST_LEASE_LOST"))}else if owned.is_cancelled(){Err(HostError("CANCELLED"))}else if a.hooks.is_some_and(|hooks| hooks.check_current().is_err()){Err(HostError("native_hook_source_changed"))}else if let Some(reads)=a.reads.as_ref(){reads.check(self,a.grant,a.args)}else{self.validate_permission(a.grant,a.args,&episode_time())};
                        match request {
                            AdmissionRequest::Check(reply)=>{let _=reply.send(valid);},
                            AdmissionRequest::CommandStarting(reply)=>{
                                let result=if let Err(error)=valid{Err(error)}else if let Some(command)=a.command{
                                    Box::pin(self.command_starting(command,owned,external)).await
                                }else{Err(HostError("native_process_owner_unknown"))};let _=reply.send(result);
                            },
                            AdmissionRequest::CommandStarted{recorder,reply}=>{
                                // Persist the actual child's identity even when
                                // dispatch permission was just withdrawn. The
                                // caller receives that withdrawal after recording.
                                let result=a.command.ok_or(HostError("native_process_owner_unknown")).and_then(|command|self.command_started(command,recorder)).and(valid);
                                let _=reply.send(result);
                            },
                            AdmissionRequest::ReadScope{path,reply}=>{
                                let result=if let Err(error)=valid{Err(error)}else{
                                    let a=authorization.as_mut().unwrap();
                                    if let Some(reads)=a.reads.as_mut(){
                                        Box::pin(self.authorize_read_scope(super::read_scope::ScopeAuthorization{primary:a.grant,args:a.args,reads,input:a.input},path,owned,external)).await
                                    }else{Err(HostError("read_scope_not_admitted"))}
                                };let _=reply.send(result);
                            },
                            AdmissionRequest::Child{handle,recorder,reply}=>{
                                let result=valid.and_then(|_|{
                                    let raw=self.resources.unsettled_handles(a.resource)?.into_iter().find(|h|h["handleId"]==handle).ok_or(HostError("mcp_handle_invalid"))?;
                                    if raw["nativeMcp"]["schemaVersion"]!=1 || !recorder.complete() || recorder.host_id!=self.journal.lease().record().host_id || recorder.acquired_at!=self.journal.lease().record().acquired_at{return Err(HostError("mcp_handle_invalid"))}
                                    let mut raw=raw;raw["nativeMcp"]["childRecorder"]=serde_json::to_value(recorder).map_err(|_|HostError("mcp_handle_invalid"))?;
                                    self.resources.mark_handle(a.resource,&raw,&episode_time())?;Ok(())
                                });let _=reply.send(result);
                            },
                            AdmissionRequest::Connection{handle,metadata,cancel,driver,reply}=>{
                                let result=valid.and_then(|_|self.register_connection(a,handle,metadata,cancel,driver));
                                let _=reply.send(result);
                            }
                            AdmissionRequest::ForegroundShellOpen{reply,..}
                            | AdmissionRequest::ForegroundShellBind{reply,..}=>{
                                let _=reply.send(Err(HostError("native_foreground_shell_unsupported")));
                            },
                            AdmissionRequest::BackgroundShellStarted{reply,..}=>{
                                let _=reply.send(Err(HostError("native_background_shell_unsupported")));
                            }
                            AdmissionRequest::StopBackgroundShell{reply,..}=>{
                                let _=reply.send(Err(HostError("native_background_shell_unsupported")));
                            }
                        }
                    }else{authorization=None;}
                },
                result=&mut future=>{if lost{return Err(HostError("HOST_LEASE_LOST"))}return Ok(result)}
            }
        }
    }
}
