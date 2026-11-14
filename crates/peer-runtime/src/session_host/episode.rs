//! One native worker episode. Goal/business acceptance belongs to the existing
//! verifier workflow, never to the final model sentence or CLI exit status.
use super::*;
use crate::{
    CancellationToken,
    canonical_history::project_history,
    execution_budget::EpisodeBudget,
    model::OpenAiChatModel,
    providers::{EffectFuture, EffectOutcome, PreparedEffect, ProviderRegistry},
    system_context::assemble_work_context,
};
use peer_store::{ConversationStore, EvidenceIndexStore, HostToolEvidence, ResourceReservation};
use std::{future::Future, pin::Pin, time::Duration};
pub trait PermissionInput {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>>;
}
pub struct EpisodeOutcome {
    pub status: &'static str,
    pub content: String,
    pub tool_calls: usize,
    pub stop: Value,
}
pub(crate) fn now() -> String {
    time::OffsetDateTime::now_utc()
        .format(
            &time::format_description::parse_borrowed::<2>(
                "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
            )
            .expect("timestamp format"),
        )
        .expect("UTC timestamp")
}
impl NativeSessionHost {
    pub async fn run_episode(
        &mut self,
        plan_id: &str,
        model: &OpenAiChatModel,
        permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
    ) -> Result<EpisodeOutcome, HostError> {
        if max_turns == 0 || max_turns > 1000 {
            return Err(HostError("invalid_max_turns"));
        }
        let current = self.current(plan_id, &now())?;
        let facts = &current.goal.facts;
        let origin = &facts["delegationOrigin"];
        let policy = peer_store::PolicyStore::new(&self.home)
            .read_existing(&current.resource.workspace_id)?;
        if origin["parentConversationId"] != policy.conversation_id {
            return Err(HostError("native_nested_context_unsupported"));
        }
        if model.model_id()
            != origin["modelSelection"]["worker"]["modelId"]
                .as_str()
                .unwrap_or("")
        {
            return Err(HostError("model_selection_unavailable"));
        }
        if facts["status"] != "executing"
            || origin["phase"] != "running"
            || facts["inheritanceStopped"] == true
            || facts["rawCheckpointDeclared"] == true
            || control(&current).is_object()
        {
            return Err(HostError("native_execution_requires_fresh_admission"));
        }
        let raw = self
            .goals
            .read_context(plan_id, &current.goal.source_revision)?;
        for name in [
            "settings.json",
            "developer-settings.json",
            "mcp-registry.json",
            "skills",
            "permissions",
        ] {
            if self.home.join(name).exists() {
                return Err(HostError("native_capability_inventory_unsupported"));
            }
        }
        if origin["capabilityAdmission"]["required"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| {
                !matches!(
                    v.as_str(),
                    Some("local.file.read" | "local.file.write" | "local.shell.exec")
                )
            })
        {
            return Err(HostError("native_capability_inventory_unsupported"));
        }
        if !raw["deliveryBinding"].is_null()
            || !raw["requestedUserInput"].is_null()
            || !raw["runner"]["verificationContinuation"].is_null()
            || !origin["memorySnapshotId"].is_null()
        {
            return Err(HostError("native_execution_context_unsupported"));
        }
        let work_id = origin["workId"]
            .as_str()
            .ok_or(HostError("work_budget_host_unavailable"))?;
        let work = &current.journal.state["works"][work_id];
        EpisodeBudget::validate_existing(&work["budget"])?;
        if !work.is_object() || crate::execution_budget::worker_work_stopped(work) {
            return Err(HostError("work_execution_stopped"));
        }
        if !matches!(
            work["state"].as_str(),
            Some(
                "runnable"
                    | "waiting_children"
                    | "waiting_user"
                    | "retry_wait"
                    | "paused"
                    | "budget_limited"
                    | "blocked_system"
                    | "delivered"
                    | "cancelled"
                    | "coalesced"
            )
        ) {
            return Err(HostError("native_work_state_unsupported"));
        }
        if !unsettled(&current).is_empty()
            || work["budget"]["attempts"]
                .as_object()
                .is_some_and(|a| !a.is_empty())
            || !work["nativeCheckpointRef"].is_null()
            || !work["checkpointRef"].is_null()
        {
            return Err(HostError("native_execution_recovery_required"));
        }
        let binding = &origin["coordinationBinding"];
        let transition = current.journal.state["transitions"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
            .find(|t| t["executionEpoch"] == binding["executionEpoch"])
            .ok_or(HostError("execution_revision_stale"))?;
        if transition["phase"] != "ready"
            || !crate::coordination::execution_binding_current(
                &current.journal.state["mandates"][work_id],
                transition,
                binding,
            )
        {
            return Err(HostError("execution_revision_stale"));
        }
        let conversation = facts["conversationId"]
            .as_str()
            .ok_or(HostError("access_identity_invalid"))?
            .to_owned();
        let metadata = ConversationStore::new(&self.home)
            .read_metadata(&conversation)?
            .metadata
            .ok_or(HostError("out_of_scope"))?;
        if metadata["role"] != "work_session"
            || metadata["workspaceId"] != current.resource.workspace_id
            || metadata["parentConversationId"] != policy.conversation_id
        {
            return Err(HostError("out_of_scope"));
        }
        let history =
            ConversationStore::new(&self.home).read_committed(&conversation, None, 1024 * 1024)?;
        if history.history.excluded_from_message_id.is_some() {
            return Err(HostError("native_execution_recovery_required"));
        }
        let projected = project_history(&history.history.messages).map_err(HostError)?;
        // Native continuity Source/legacy checkpoint replay is a later adapter;
        // never silently drop a compaction handoff from an admitted request.
        if projected.get("continuity").is_some() {
            return Err(HostError("native_continuity_context_unsupported"));
        }
        let workspace = current
            .resource
            .directory
            .as_ref()
            .ok_or(HostError("execution_resource_scope_unknown"))?
            .clone();
        // Sources still awaiting their native discovery adapter must not vanish
        // from a production request. The first P3 slice fails closed here.
        for directory in workspace.ancestors() {
            for name in ["AGENTS.md", "CLAUDE.md"] {
                if directory.join(name).exists() {
                    return Err(HostError("native_project_instruction_source_unsupported"));
                }
            }
        }
        for name in [".peer", ".claude", ".agents"] {
            if workspace.join(name).exists() {
                return Err(HostError("native_project_context_source_unsupported"));
            }
        }
        if current.resource.read_only {
            return Err(HostError("native_readonly_episode_unsupported"));
        }
        let lease = self.journal.lease().record();
        let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
        let recorder = crate::recorder::local_recorder(&lease.host_id, &lease.acquired_at)
            .await
            .ok_or(HostError("native_recorder_unavailable"))?;
        let native_recorder = json!({"schemaVersion":1,"runtime":"peer-native","execution":facts["execution"],"recorder":recorder});
        if self.resources.has_claim(&current.resource)?
            && !self.resources.admitted(&current.resource, &epoch)?
        {
            return Err(HostError("execution_resource_owner_unknown"));
        }
        let reserved = self.resources.reserve(
            &current.resource,
            ResourceReservation {
                host_epoch: &epoch,
                scopes: &[],
                record_conflict: false,
            },
            &now(),
        )?;
        if reserved["allowed"] != true {
            return Err(HostError("execution_resource_busy"));
        }
        if !self.resources.activate(&current.resource, &epoch, &now())? {
            return Err(HostError("execution_resource_owner_unknown"));
        }
        let attempt = self
            .live
            .begin(&current.resource.execution)
            .map_err(|_| HostError("execution_resource_owner_unknown"))?;
        let cancellation = attempt.cancellation();
        self.journal.append(&current.journal,&json!({"kind":"coordination_transition","operationId":transition["operationId"],"expectedPhase":"ready","patch":{"phase":"started","updatedAt":now()}}),milliseconds(&now())?,&NativeCoordinationReducer,None)?;
        let budget = EpisodeBudget {
            work: work_id.into(),
            attempt: uuid::Uuid::new_v4().to_string(),
            plan: plan_id.into(),
            session: current.resource.execution.session_id.clone(),
            native_recorder,
        };
        let mut providers = ProviderRegistry::default();
        let projection = providers.project()?;
        let stream = format!("native-{}", uuid::Uuid::new_v4());
        let run=async {
            let mut count=0;let mut content=String::new();
            for _ in 0..max_turns {
                if cancel.is_cancelled() || cancellation.is_cancelled(){return Err(HostError("CANCELLED"))}
                let fresh=self.current(plan_id,&now())?;
                let policy=peer_store::PolicyStore::new(&self.home).read_existing(&fresh.resource.workspace_id)?;
                if policy.conversation_id!=origin["parentConversationId"]{return Err(HostError("out_of_scope"))}
                if fresh.goal.source_revision!=current.goal.source_revision || !crate::coordination::execution_binding_current(&fresh.journal.state["mandates"][work_id],&fresh.journal.state["transitions"][transition["operationId"].as_str().unwrap_or("")],binding){return Err(HostError("execution_revision_stale"))}
                let system=assemble_work_context(workspace.to_str().ok_or(HostError("invalid_workspace"))?,model.model_id(),&raw,&now()).map_err(HostError)?;
                let history=ConversationStore::new(&self.home).read_committed(&conversation,None,1024*1024)?;
                if history.history.excluded_from_message_id.is_some(){return Err(HostError("native_execution_recovery_required"))}
                let projected=project_history(&history.history.messages).map_err(HostError)?;
                budget.request(self,&now())?;
                let turn=self.wait_owned(model.turn(system["rendered"].as_str().unwrap(),&projected,&projection.definitions(),&cancellation),&cancellation,cancel).await?;
                let turn=match turn{Ok(turn)=>turn,Err(e)=>{budget.usage(self,None,&now())?;return Err(HostError(e.0))}};
                budget.usage(self,turn.usage.as_ref(),&now())?;
                if !turn.content.is_empty(){self.append_episode_message(&conversation,&json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","content":turn.content,"createdAt":now(),"streamId":stream,"contextSnapshot":system["snapshot"],"requestFingerprint":turn.request_fingerprint}))?;content=turn.content;}
                if turn.calls.is_empty(){return Ok(("replied",content,count))}
                for call in turn.calls {
                    if cancel.is_cancelled() || cancellation.is_cancelled(){return Err(HostError("CANCELLED"))}
                    let effect=providers.prepare(&projection,&call.name,call.arguments,&workspace,&self.home)?;
                    let capability=projection.capability(&call.name).ok_or(HostError("tool_not_projected"))?.to_owned();
                    let call_id=format!("call-{}",uuid::Uuid::new_v4());let args=effect.args().clone();let scopes=effect.scopes()?;
                    let current=self.current(plan_id,&now())?;
                    let reserved=self.resources.reserve(&current.resource,ResourceReservation{host_epoch:&epoch,scopes:&scopes,record_conflict:false},&now())?;
                    if reserved["allowed"]!=true{return Err(HostError("execution_resource_busy"))}
                    let identity=||HostCallIdentity{plan_id,session_id:&budget.session,conversation_id:&conversation,tool_call_id:&call_id,stream_id:&stream,capability_id:&capability,permission:effect.permission(),role:HostExecutionRole::Worker,shell_risk:effect.risk()};
                    let grant=if let Some(g)=self.automatic_permission(identity(),&args,&now())?{Some(g)}else{
                        let pending=self.request_permission(identity(),&args,&now())?;
                        let decision=self.wait_owned(permission.decide(json!({"approval":pending.record(),"tool":call.name,"arguments":args,"scopes":scopes}),&cancellation),&cancellation,cancel).await?;
                        let cancelled=matches!(decision,LocalPermissionDecision::Cancel);
                        let grant=self.decide_permission(pending,decision,&args,&now())?;
                        if cancelled{return Err(HostError("CANCELLED"))}grant
                    };
                    let dispatch=budget.dispatch(self,crate::execution_budget::DispatchFacts{call:&call_id,capability:&capability,scopes:&scopes,stream:&stream,conversation:&conversation},&now())?;
                    let grant_facts=grant.as_ref().map(|g|g.facts().clone()).unwrap_or_else(||json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":call_id,"granted":false,"scope":capability,"duration":"denied","decidedAt":now(),"reason":"local_permission_denied"}));
                    let outcome=if let Some(grant)=grant {
                        self.launch_effect(effect,&grant,&current.resource,&call_id,&cancellation,cancel).await?
                    }else{EffectOutcome{status:"denied",output:json!({}),error:Some("permission_denied"),artifacts:vec![],ended:true}};
                    #[cfg(feature="test-fixtures")]
                    if std::env::var("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT").ok().as_deref()==Some(&call.name) && self.home.join(".native-cli-fixture").is_file(){std::process::exit(77)}
                    let mut result=json!({"toolCallId":call_id,"capabilityId":capability,"status":outcome.status,"output":outcome.output,"outputPreview":{"kind":"json"},"completedAt":now(),"evidence":{"evidenceId":format!("evidence-{}",uuid::Uuid::new_v4()),"toolCallId":call_id,"summary":format!("{}: {}",call.name,outcome.status),"artifactRefs":outcome.artifacts}});
                    if let Some(error)=outcome.error{result["error"]=json!({"code":error,"message":error,"recoverable":true})}
                    self.append_episode_message(&conversation,&json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","content":"","createdAt":now(),"streamId":stream,"segments":[{"type":"tool-call","tool":call.name,"toolCallId":call_id,"args":args,"result":result}],"permissionGrants":[grant_facts]}))?;
                    EvidenceIndexStore::new(&self.home).register(&HostToolEvidence{conversation_id:&conversation,plan_id:Some(plan_id),stream_id:Some(&stream),tool_name:&call.name,capability_id:&capability,tool_call_id:&call_id,grant:&grant_facts,result:&result},None)?;
                    budget.settle(self,&call_id,&dispatch,&result,&now())?;count+=1;
                    if !outcome.ended || outcome.error==Some("execution_outcome_unknown"){return Err(HostError("execution_outcome_unknown"))}
                }
            }Ok(("max_turns",content,count))
        }.await;
        // Completion owns the actual attempt. Stop drains its real handles;
        // errors leave canonical pending dispatches/unknown intact.
        let finished = budget.finish(self, &now());
        attempt.finish();
        finished?;
        let operation = format!("native-pause-{}", uuid::Uuid::new_v4());
        self.begin_stop(plan_id, "pause", &operation, "host:native-exec", &now())
            .await?;
        self.drain_stop(plan_id, &operation, Duration::from_secs(5), &now())
            .await?;
        let stop = self.settle_stop(plan_id, &operation, &now())?;
        if stop["phase"] == "settled" {
            self.persist_episode_pause(plan_id, &stop)?;
        } else {
            return Err(HostError("execution_outcome_unknown"));
        }
        let (status, content, tool_calls) = run?;
        Ok(EpisodeOutcome {
            status,
            content,
            tool_calls,
            stop,
        })
    }
    fn append_episode_message(&self, conversation: &str, message: &Value) -> Result<(), HostError> {
        let store = ConversationStore::new(&self.home);
        let snapshot = store.read_committed(conversation, None, 1024 * 1024)?;
        store.commit_message(&snapshot, message, &now(), None)?;
        Ok(())
    }
    pub(super) fn persist_episode_pause(
        &self,
        plan: &str,
        control: &Value,
    ) -> Result<(), HostError> {
        let current = self.current(plan, &now())?;
        let projector = TuiGoalProjector::new(&now()).map_err(HostError)?;
        self.goals
            .prepare_execution_mirror(
                self.journal.lease(),
                plan,
                &current.goal.source_revision,
                &projector,
                None,
            )?
            .commit(GoalExecutionFact::ManagedPause(control), &now(), None)?;
        Ok(())
    }
    async fn wait_owned<F: Future>(
        &mut self,
        future: F,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<F::Output, HostError> {
        tokio::pin!(future);
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.tick().await;
        let mut cancelled = false;
        let mut lost = false;
        loop {
            tokio::select! {biased;r=&mut future=>{if lost{return Err(HostError("HOST_LEASE_LOST"))}return Ok(r)},_=external.cancelled(),if !cancelled=>{owned.cancel();cancelled=true},_=tick.tick()=>{if !self.journal.lease().holds().unwrap_or(false) || self.journal.lease().takeover_requested().unwrap_or(true) || self.journal.heartbeat(milliseconds(&now())?).is_err(){lost=true;owned.cancel()}}}
        }
    }
    async fn launch_effect(
        &mut self,
        effect: Box<dyn PreparedEffect>,
        grant: &HostPermissionGrant,
        resource: &HostResourcePlan,
        call: &str,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<EffectOutcome, HostError> {
        let handle = effect.handle().map(str::to_owned);
        if let Some(handle) = handle.as_deref() {
            self.resources.mark_handle(
                resource,
                &json!({"handleId":handle,"toolCallId":call,"state":"active"}),
                &now(),
            )?;
            let (send, recv) = tokio::sync::oneshot::channel();
            let (start, started) = tokio::sync::oneshot::channel::<EffectFuture>();
            let registration = self.live.track_handle(
                &resource.execution,
                handle,
                call,
                owned.clone(),
                async move {
                    let future = started.await.map_err(|_| ())?;
                    let outcome = future.await;
                    let ended = outcome.ended;
                    let _ = send.send(outcome);
                    if ended { Ok(()) } else { Err(()) }
                },
            );
            if registration.is_err() {
                self.resources.mark_handle(
                    resource,
                    &json!({"handleId":handle,"toolCallId":call,"state":"ended"}),
                    &now(),
                )?;
                return Ok(EffectOutcome::failed("execution_resource_owner_unknown"));
            }
            // Registry capacity and the actual completion owner exist BEFORE
            // spawn. No rejected registration can leave an unowned child.
            let future = match effect.start(self, grant, owned.clone(), &now()) {
                Ok(future) => future,
                Err(e) => Box::pin(async move { EffectOutcome::failed(e.0) }),
            };
            start
                .send(future)
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            let outcome = self
                .wait_owned(recv, owned, external)
                .await?
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            if outcome.ended {
                self.resources.mark_handle(
                    resource,
                    &json!({"handleId":handle,"toolCallId":call,"state":"ended"}),
                    &now(),
                )?;
                self.live
                    .acknowledge_ended_handle(&resource.execution, handle)
                    .map_err(|_| HostError("execution_stop_unconfirmed"))?;
            }
            Ok(outcome)
        } else {
            match effect.start(self, grant, owned.clone(), &now()) {
                Ok(future) => self.wait_owned(future, owned, external).await,
                Err(e) => Ok(EffectOutcome::failed(e.0)),
            }
        }
    }
}
