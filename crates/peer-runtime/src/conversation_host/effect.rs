//! The real Provider future and its bounded control port stay owned until they
//! return. Errors/cancellation never replace an observed completion or child.
use super::*;
use crate::{
    effect_admission::{AdmissionRequest, EffectAdmission},
    providers::{EffectFuture, EffectOutcome, PreparedEffect, ProviderCall},
    recorder,
};
use peer_protocol::{
    NativeOwnedProcess, NativeProcessKind, NativeProcessState as Process, NativeProcessStop,
};
impl Host<'_> {
    pub(super) fn factual_publication(
        &mut self,
        receipt: ConversationMetadataPublication,
    ) -> Result<(), HostError> {
        let result = self.publication(receipt);
        if result.is_err() {
            self.owned.cancel();
        }
        result
    }
    pub(super) async fn launch(
        &mut self,
        mut effect: Box<dyn PreparedEffect>,
        grant: &mut ToolGrant,
        dispatch: &str,
    ) -> Result<(EffectOutcome, Option<HostError>, bool), HostError> {
        self.validate_grant(grant, effect.args())?;
        let args = effect.args().clone();
        let handle = effect.handle().map(str::to_owned);
        let command = effect.owned_command();
        let background = effect.background_shell();
        let foreground = effect.foreground_shell();
        if background && !self.can_start_background_shell() {
            return Ok((
                EffectOutcome::not_dispatched("shell_background_limit"),
                None,
                false,
            ));
        }
        let effect_cancel = if background {
            self.owned.child_token()
        } else {
            self.owned.clone()
        };
        let mut handle_metadata = None;
        if command {
            let process = NativeOwnedProcess {
                schema_version: 1,
                kind: NativeProcessKind::Command,
                handle_id: handle
                    .clone()
                    .ok_or(HostError("native_process_owner_unknown"))?,
                tool_call_id: grant.call.clone(),
                dispatch_id: dispatch.into(),
                execution: json!(self.identity),
                generation: 0,
                state: Process::NotStarted,
                owner: self.run.owner().clone(),
                child: None,
                stop_observation: None,
            };
            let receipt =
                self.store
                    .record_conversation_process(&mut self.run, &process, &now())?;
            self.publication(receipt)?;
            if background {
                handle_metadata = Some(peer_protocol::background_shell_handle(&process));
            }
        }
        let (mut port, mut requests) = EffectAdmission::channel(&effect_cancel);
        port.owner = Some(self.run.owner().clone());
        port.confined_reads = self.explorer.is_some();
        effect.admission(port);
        let primary = handle.clone();
        let mut provider_call =
            ProviderCall::new(&self.identity.conversation_id, &grant.call, &now());
        provider_call.goal_runner = self.runner.as_ref().map(|runner| runner.lease.clone());
        let mut future: EffectFuture = if let Some(handle) = &primary {
            let record = handle_metadata.unwrap_or_else(|| {
                let metadata = json!({"kind":"effect","nativeMcp":effect.handle_metadata()});
                json!({"handleId":handle,"toolCallId":grant.call,"state":"active","metadata":metadata})
            });
            let receipt =
                self.store
                    .register_conversation_handle(&mut self.run, &record, &now())?;
            self.publication(receipt)?;
            let (start, started) = tokio::sync::oneshot::channel::<EffectFuture>();
            let (send, receive) = tokio::sync::oneshot::channel();
            if self
                .live
                .track_handle(
                    &self.identity,
                    handle,
                    &grant.call,
                    effect_cancel.clone(),
                    async move {
                        let future = started.await.map_err(|_| ())?;
                        let outcome = future.await;
                        let ended = outcome.ended;
                        let _ = send.send(outcome);
                        if ended { Ok(()) } else { Err(()) }
                    },
                )
                .is_err()
            {
                let receipt = self
                    .store
                    .end_conversation_handle(&mut self.run, handle, &now())?;
                self.publication(receipt)?;
                if command {
                    self.record_command_end(&grant.call, true)?;
                }
                return Ok((
                    EffectOutcome::not_dispatched("native_execution_owner_unavailable"),
                    None,
                    false,
                ));
            }
            let effect = effect
                .start(provider_call, effect_cancel.clone())
                .unwrap_or_else(|e| Box::pin(async move { EffectOutcome::not_dispatched(e.0) }));
            start
                .send(effect)
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            Box::pin(async move {
                receive.await.unwrap_or_else(|_| {
                    let mut e = EffectOutcome::failed("execution_outcome_unknown");
                    e.ended = false;
                    e
                })
            })
        } else {
            effect.start(provider_call, effect_cancel.clone())?
        };
        let mut stopped = None;
        let mut closed = false;
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.tick().await;
        let mut outcome = loop {
            tokio::select! {biased;
                _=self.external.cancelled(),if stopped.is_none()=>{self.owned.cancel();stopped=Some(HostError("CANCELLED"));},
                _=tick.tick(),if stopped.is_none()=>{
                    self.check_background_shells();
                    if let Err(e)=self.validate_grant(grant,&args){self.owned.cancel();stopped=Some(e);}
                },
                request=requests.recv(),if !closed=>{
                    tokio::task::yield_now().await;
                    let valid=self.validate_grant(grant,&args);
                    if let Err(e)=valid {if stopped.is_none(){stopped=Some(e);}self.owned.cancel();}
                    match request {
                        None=>closed=true,
                        Some(AdmissionRequest::Check(reply))=>{let _=reply.send(valid);},
                        Some(AdmissionRequest::ReadScope{path,reply})=>{
                            let result=match valid{Err(e)=>Err(e),Ok(())=>self.authorize_read(grant,&args,path).await};
                            if let Err(e)=result{if stopped.is_none(){stopped=Some(e);}self.owned.cancel();}let _=reply.send(result);
                        },
                        Some(AdmissionRequest::CommandStarting(reply))=>{
                            let result=if let Err(e)=valid{Err(e)}else if command{self.command_start(&grant.call).await}else{Err(HostError("native_process_owner_unknown"))};let _=reply.send(result);
                        },
                        Some(AdmissionRequest::CommandStarted{recorder,reply})=>{
                            // The real child is accountability even after withdrawal.
                            let result = if foreground {
                                self.foreground_shell_spawned(&grant.call, dispatch, recorder)
                            } else if command {
                                self.command_spawned(&grant.call, recorder)
                            } else {
                                Err(HostError("native_process_owner_unknown"))
                            };
                            let _=reply.send(result.and(valid));
                        },
                        Some(AdmissionRequest::ForegroundShellOpen{handle,cancel,driver,reply})=>{
                            let result = valid.and_then(|_| {
                                if !foreground { return Err(HostError("native_foreground_shell_unsupported")); }
                                self.foreground_shell_open(grant, dispatch, handle, cancel, driver)
                            });
                            let _=reply.send(result);
                        },
                        Some(AdmissionRequest::ForegroundShellBind{handle,reply})=>{
                            let result = valid.and_then(|_| {
                                if !foreground { return Err(HostError("native_foreground_shell_unsupported")); }
                                self.foreground_shell_bind(grant, dispatch, &handle)
                            });
                            let _=reply.send(result);
                        },
                        Some(AdmissionRequest::BackgroundShellStarted{observation,reply})=>{
                            let result = valid.and_then(|_| {
                                if !background { return Err(HostError("native_background_shell_unsupported")); }
                                let process = self.process(&grant.call)?;
                                self.verify_background_start(&process, &observation)?;
                                Ok(process.handle_id)
                            });
                            match result {
                                Ok(handle) => {
                                    if reply.send(Ok(())).is_ok() {
                                        self.track_background_shell(handle, grant.clone(), args, effect_cancel, future);
                                        return Ok((observation, None, true));
                                    }
                                    effect_cancel.cancel();
                                }
                                Err(error) => { let _ = reply.send(Err(error)); }
                            }
                        },
                        Some(AdmissionRequest::StopBackgroundShell{task_id,reply})=>{
                            let result = match valid {
                                Ok(()) if grant.capability == "local.shell.stop"
                                    && args["taskId"].as_str().map(str::trim) == Some(&task_id) =>
                                        self.stop_background_shell(&task_id, grant, &args).await,
                                Ok(()) => Err(HostError("shell_task_stop_invalid")),
                                Err(error) => Err(error),
                            };
                            let _ = reply.send(result);
                        },
                        Some(AdmissionRequest::Connection{handle,metadata,cancel,driver,reply})=>{
                            let result=valid.and_then(|_|self.connection(grant,handle,metadata,cancel,driver));let _=reply.send(result);
                        },
                        Some(AdmissionRequest::Child{handle,recorder,reply})=>{
                            let result=self.store.record_conversation_handle_child(&mut self.run,&handle,&recorder,&now()).map_err(Into::into).and_then(|r|self.factual_publication(r));
                            let _=reply.send(result.and(valid));
                        },
                    }
                },
                result=&mut future=>break result,
            }
        };
        if outcome.ended {
            if let Some(handle) = primary {
                // A oneshot can wake before the completion guard's destructor.
                // Wait for the registry's real observation, never a timer proof.
                let mut ended = false;
                for _ in 0..100 {
                    let observations = self
                        .live
                        .handle_observations(&self.identity)
                        .map_err(|_| HostError("native_execution_stop_unproven"))?;
                    if observations
                        .iter()
                        .any(|(id, _, state)| id == &handle && *state == "ended")
                    {
                        ended = true;
                        break;
                    }
                    if observations
                        .iter()
                        .any(|(id, _, state)| id == &handle && *state == "unknown")
                    {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                if ended {
                    let receipt =
                        self.store
                            .end_conversation_handle(&mut self.run, &handle, &now())?;
                    if let Err(e) = self.factual_publication(receipt) {
                        stopped = stopped.or(Some(e));
                    }
                    self.live
                        .acknowledge_ended_handle(&self.identity, &handle)
                        .map_err(|_| HostError("native_execution_stop_unproven"))?;
                } else {
                    outcome.ended = false;
                    outcome.status = "failed";
                    outcome.error = Some("execution_outcome_unknown");
                }
            }
            if command
                && outcome.ended
                && let Err(e) = self.record_command_end(&grant.call, true)
            {
                stopped = stopped.or(Some(e));
            }
        }
        Ok((outcome, stopped, false))
    }
    pub(super) fn record_command_end(
        &mut self,
        call: &str,
        advance: bool,
    ) -> Result<(), HostError> {
        let mut process = self.process(call)?;
        process.state = Process::Ended;
        process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
        let receipt = self
            .store
            .record_conversation_process(&mut self.run, &process, &now())?;
        if advance {
            self.factual_publication(receipt)?;
        }
        Ok(())
    }
    pub(super) fn process(&self, call: &str) -> Result<NativeOwnedProcess, HostError> {
        self.store
            .read_conversation_execution(&self.identity.conversation_id)?
            .ok_or(HostError("conversation_execution_changed"))?
            .pending_tools
            .into_iter()
            .find(|p| p.tool_call_id == call)
            .and_then(|p| p.native_process)
            .ok_or(HostError("native_process_owner_unknown"))
    }
    async fn command_start(&mut self, call: &str) -> Result<(), HostError> {
        let mut p = self.process(call)?;
        if p.state == Process::Running {
            let child = p
                .child
                .as_ref()
                .ok_or(HostError("native_process_invalid"))?;
            if !self
                .wait_owned(recorder::prove(child))
                .await?
                .allows_settlement()
                || !crate::providers::group_absent(child.pid)
            {
                return Err(HostError("native_process_still_running"));
            }
            p.state = Process::Ended;
            p.stop_observation = Some(NativeProcessStop::OwnedCompletion);
            let receipt = self
                .store
                .record_conversation_process(&mut self.run, &p, &now())?;
            self.publication(receipt)?;
        }
        if !matches!(p.state, Process::NotStarted | Process::Ended) || p.generation >= 64 {
            return Err(HostError("native_process_transition_invalid"));
        }
        p.generation += 1;
        p.state = Process::Starting;
        p.child = None;
        p.stop_observation = None;
        let receipt = self
            .store
            .record_conversation_process(&mut self.run, &p, &now())?;
        self.publication(receipt)
    }
    pub(super) fn observe_spawned_process(
        p: &mut NativeOwnedProcess,
        child: recorder::Recorder,
    ) -> Result<(), HostError> {
        if p.state != Process::Starting
            || !child.complete()
            || child.boot_id != p.owner.boot_id
            || child.host_id != p.owner.host_id
            || child.acquired_at != p.owner.acquired_at
        {
            return Err(HostError("native_process_recorder_invalid"));
        }
        let pid = rustix::process::Pid::from_raw(child.pid as i32)
            .ok_or(HostError("native_process_invalid"))?;
        if !matches!(rustix::process::getpgid(Some(pid)),Ok(group) if group==pid)
            && rustix::process::getpgid(Some(pid)) != Err(rustix::io::Errno::SRCH)
        {
            return Err(HostError("native_process_group_unproven"));
        }
        p.child = Some(child);
        p.state = Process::Running;
        Ok(())
    }
    fn command_spawned(&mut self, call: &str, child: recorder::Recorder) -> Result<(), HostError> {
        let mut p = self.process(call)?;
        Self::observe_spawned_process(&mut p, child)?;
        let receipt = self
            .store
            .record_conversation_process(&mut self.run, &p, &now())?;
        self.factual_publication(receipt)
    }
    fn connection(
        &mut self,
        grant: &ToolGrant,
        handle: String,
        metadata: Value,
        cancel: CancellationToken,
        driver: crate::effect_admission::ConnectionDriver,
    ) -> Result<(), HostError> {
        let registry = McpRegistryStore::new(&self.home).read()?;
        let manifest = registry
            .inventory
            .manifests
            .iter()
            .find(|m| m["capabilityId"] == grant.capability)
            .ok_or(HostError("mcp_handle_invalid"))?;
        if !grant.capability.starts_with("local.mcp.")
            || metadata["schemaVersion"] != 1
            || metadata["role"] != "connection"
            || metadata["registryRevision"] != self.registry
            || registry.source_revision != self.registry
            || metadata["ownerRecorder"] != json!(self.run.owner())
            || metadata["transport"] != manifest["origin"]["transport"]
            || cancel.is_cancelled()
        {
            return Err(HostError("mcp_handle_invalid"));
        }
        let receipt=self.store.register_conversation_handle(&mut self.run,&json!({"handleId":handle,"toolCallId":grant.call,"state":"active","metadata":{"kind":"mcp_connection","nativeMcp":metadata}}),&now())?;
        self.publication(receipt)?;
        if self
            .live
            .track_handle(&self.identity, &handle, &grant.call, cancel, driver)
            .is_err()
        {
            let receipt = self
                .store
                .end_conversation_handle(&mut self.run, &handle, &now())?;
            self.publication(receipt)?;
            return Err(HostError("mcp_connection_owner_unavailable"));
        }
        Ok(())
    }
}
