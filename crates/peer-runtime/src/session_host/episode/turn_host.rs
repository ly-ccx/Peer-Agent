//! Goal-specific authority and canonical settlement behind the shared loop.
use super::hook_message::HookMessage;
use super::hooks::{HookResults, SelectedHooks, WorkHookCall, run_hooks};
use super::*;
use crate::cognition::ContextPipeline;
use crate::model::{ModelContinuation, ModelToolCall, ModelTurn};
use crate::session_host::cognition_host::GoalRequestFrame;
use crate::turn_loop::TurnHost;
use crate::{hook_policy::HookDecision, hook_process::decision_name};
use peer_store::HookPhase;
use peer_store::{EvidenceIndexStore, HostFileMaterialization, HostToolEvidence};

pub(super) struct GoalTurnHost<'a, 'f> {
    pub host: &'a mut NativeSessionHost,
    pub frame: &'a GoalRequestFrame<'f>,
    pub pipeline: &'a mut ContextPipeline,
    pub providers: &'a mut ProviderRegistry,
    pub projection: &'a crate::providers::RuntimeProjection,
    pub permission: &'a mut dyn PermissionInput,
    pub epoch: &'a str,
    pub stream: &'a str,
    pub origin: &'a Value,
    pub transition: &'a Value,
    pub binding: &'a Value,
    pub usage: &'a mut RuntimeUsageAccounting,
    pub system: Option<Value>,
}
impl TurnHost for GoalTurnHost<'_, '_> {
    async fn request(&mut self) -> Result<ModelTurn, HostError> {
        let f = self.frame;
        if self.host.has_work_background_shells() {
            let resource = self.host.current(f.plan, &now())?.resource;
            self.host.reap_work_background_shells(&resource).await?;
        }
        let fresh = self.host.current(f.plan, &now())?;
        let policy = peer_store::PolicyStore::new(&self.host.home)
            .read_existing(&fresh.resource.workspace_id)?;
        if policy.conversation_id != self.origin["parentConversationId"] {
            return Err(HostError("out_of_scope"));
        }
        if fresh.goal.source_revision != f.goal_revision
            || !crate::coordination::execution_binding_current(
                &fresh.journal.state["mandates"][f.budget.work.as_str()],
                &fresh.journal.state["transitions"]
                    [self.transition["operationId"].as_str().unwrap_or("")],
                self.binding,
            )
        {
            return Err(HostError("execution_revision_stale"));
        }
        let home = self.host.home.clone();
        let request = crate::cognition::CognitionRequest {
            home: &home,
            model: f.model,
            tools: f.tools,
            owned: f.owned,
            external: f.external,
        };
        let mut host = crate::session_host::cognition_host::GoalCognitionHost {
            host: self.host,
            frame: f,
        };
        let response = self
            .pipeline
            .request(&mut host, &request, self.usage)
            .await?;
        self.system = Some(response.system);
        Ok(response.turn)
    }
    async fn record_assistant(&mut self, turn: &ModelTurn) -> Result<(), HostError> {
        let system = self
            .system
            .take()
            .ok_or(HostError("context_response_unavailable"))?;
        self.host.append_episode_message(self.frame.billing.conversation,&json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","content":turn.content,"createdAt":now(),"streamId":self.stream,"contextSnapshot":system["snapshot"],"requestFingerprint":turn.request_fingerprint}))
    }
    async fn execute_call(&mut self, call: ModelToolCall) -> Result<String, HostError> {
        let host = &mut *self.host;
        let frame = self.frame;
        frame
            .hooks
            .check_current()
            .map_err(|_| HostError("native_hook_source_changed"))?;
        let plan_id = frame.plan;
        let conversation = frame.billing.conversation;
        let workspace = frame.workspace;
        let budget = frame.budget;
        let cancellation = frame.owned;
        let cancel = frame.external;
        let providers = &mut *self.providers;
        let projection = self.projection;
        let permission = &mut *self.permission;
        let epoch = self.epoch;
        let stream = self.stream;
        let effect = providers.prepare(
            projection,
            &call.name,
            call.arguments,
            workspace,
            &host.home,
        )?;
        let capability = projection
            .capability(&call.name)
            .ok_or(HostError("tool_not_projected"))?
            .to_owned();
        let call_id = format!("call-{}", uuid::Uuid::new_v4());
        let args = effect.args().clone();
        let scopes = effect.scopes()?;
        let provider_evidence = effect.evidence();
        let output_kind = effect.output_kind();
        let command_effect = effect.owned_command();
        let foreground_shell = effect.foreground_shell();
        let current = host.current(plan_id, &now())?;
        host.reap_work_background_shells(&current.resource).await?;
        let unowned_stop = effect.permission() == ProviderPermission::ShellStop
            && !host.work_background_shell_owned(&current.resource, &args["taskId"], stream);
        let background = effect.background_shell();
        let reserved = host.resources.reserve(
            &current.resource,
            ResourceReservation {
                host_epoch: epoch,
                scopes: &scopes,
                record_conflict: false,
            },
            &now(),
        )?;
        if reserved["allowed"] != true {
            return Err(HostError("execution_resource_busy"));
        }
        let identity = || HostCallIdentity {
            plan_id,
            session_id: &budget.session,
            conversation_id: conversation,
            tool_call_id: &call_id,
            stream_id: stream,
            capability_id: &capability,
            permission: effect.permission(),
            role: HostExecutionRole::Worker,
            shell_risk: effect.risk(),
        };
        let identity = identity();
        let selected = if unowned_stop {
            SelectedHooks::default()
        } else {
            SelectedHooks::select(frame.hooks, &capability, &args)?
        };
        let intent = selected
            .any()
            .then(|| {
                Ok::<_, HostError>(peer_protocol::WorkHookIntent {
                    message_id: format!("message-{}", uuid::Uuid::new_v4()),
                    args_digest: peer_protocol::approval_args_digest(&args)
                        .map_err(|_| HostError("permission_arguments_invalid"))?,
                })
            })
            .transpose()?;
        let message = intent.as_ref().map(|intent| HookMessage {
            intent,
            conversation,
            stream,
            call: &call_id,
            tool: &call.name,
            args: &args,
        });
        let dispatch_facts = || crate::execution_budget::DispatchFacts {
            call: &call_id,
            capability: &capability,
            scopes: &scopes,
            stream,
            conversation,
            hook_intent: intent.as_ref(),
        };
        let prepared = selected
            .any()
            .then(|| budget.dispatch(host, dispatch_facts(), &now()))
            .transpose()?;
        if let Some(message) = &message {
            message.publish(host)?;
        }
        let hook_call = |dispatch| WorkHookCall {
            identity,
            tool: &call.name,
            args: &args,
            projection: projection.id(),
            dispatch,
        };
        let mut hooks = if let Some(dispatch) = prepared.as_deref() {
            run_hooks(
                host,
                frame,
                hook_call(dispatch),
                &selected.pre,
                HookPhase::PreToolUse,
                None,
            )
            .await?
        } else {
            HookResults::default()
        };
        let mut authorization = if unowned_stop {
            crate::session_host::tool_authorization::ToolAuthorization::not_dispatched(HostError(
                "shell_task_not_found",
            ))
        } else if let Some(error) = hooks.interrupted {
            crate::session_host::tool_authorization::ToolAuthorization::hook_block(
                error.0,
                Some(error),
            )
        } else if hooks.decision == HookDecision::Deny {
            crate::session_host::tool_authorization::ToolAuthorization::hook_block(
                "hook_denied",
                None,
            )
        } else {
            host.authorize_tool(
                crate::session_host::tool_authorization::ToolAuthorizationRequest {
                    identity,
                    args: &args,
                    tool: &call.name,
                    scopes: &scopes,
                    read_path: effect.read_scope(),
                    workspace,
                    hooks: Some(frame.hooks),
                    require_confirmation: hooks.decision == HookDecision::Ask,
                },
                permission,
                cancellation,
                cancel,
            )
            .await?
        };
        let started_at = now();
        let dispatch = match prepared.as_ref() {
            Some(value) => value.clone(),
            None => budget.dispatch(host, dispatch_facts(), &started_at)?,
        };
        let grant_facts = authorization
            .grant
            .as_ref()
            .map(|g| g.facts().clone())
            .unwrap_or_else(|| authorization.denied_facts(&call_id, &capability));
        let admission_error = if authorization.grant.is_some() {
            frame
                .hooks
                .check_current()
                .err()
                .map(|_| HostError("native_hook_source_changed"))
        } else {
            None
        };
        let outcome = if let Some(error) = authorization.failure.or(admission_error) {
            EffectOutcome::not_dispatched(error.0)
        } else if let Some(grant) = authorization.grant.as_ref() {
            if message.is_some() {
                budget.begin_hook_provider(host, &call_id, &dispatch, &grant_facts, &now())?;
            }
            host.launch_effect(
                effect,
                crate::session_host::effect_wait::EffectHost {
                    grant,
                    resource: &current.resource,
                    input: permission,
                    reads: authorization.reads.as_mut(),
                    budget,
                    dispatch: &dispatch,
                    hooks: Some(frame.hooks),
                },
                cancellation,
                cancel,
            )
            .await?
        } else {
            EffectOutcome {
                status: match authorization.terminal {
                    Some(HostError("CANCELLED")) => "cancelled",
                    Some(_) => "failed",
                    None => "denied",
                },
                output: json!({}),
                error: Some(authorization.terminal.map(|e| e.0).unwrap_or_else(|| {
                    match (hooks.decision, authorization.reason) {
                        (HookDecision::Deny, _) => "hook_denied",
                        (HookDecision::Ask, Some("permission_unavailable")) => {
                            "hook_approval_required"
                        }
                        (HookDecision::Ask, _) => "hook_approval_denied",
                        _ => "permission_denied",
                    }
                })),
                artifacts: vec![],
                ended: true,
                materialization: None,
                not_dispatched: true,
            }
        };
        let background_started =
            background && outcome.status == "success" && !outcome.ended && outcome.error.is_none();
        let permission_terminal = admission_error
            .or(authorization.terminal)
            .or_else(|| authorization.reads.as_ref().and_then(|r| r.terminal));
        let additional = authorization
            .reads
            .as_ref()
            .map(|r| {
                r.grants
                    .iter()
                    .map(|g| g.facts().clone())
                    .chain(r.decisions.iter().cloned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        #[cfg(feature = "test-fixtures")]
        if std::env::var("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT")
            .ok()
            .as_deref()
            == Some(&call.name)
            && host.home.join(".native-cli-fixture").is_file()
        {
            std::process::exit(77)
        }
        let mut result = json!({"toolCallId":call_id,"capabilityId":capability,"status":outcome.status,"output":outcome.output,"outputPreview":{"kind":"json"},"completedAt":now(),"evidence":{"evidenceId":format!("evidence-{}",uuid::Uuid::new_v4()),"toolCallId":call_id,"summary":format!("{}: {}",call.name,outcome.status),"artifactRefs":outcome.artifacts}});
        if let Some(metadata) = provider_evidence {
            let target = result["evidence"].as_object_mut().unwrap();
            target.extend(metadata.as_object().unwrap().clone());
            target.insert("permissionGrantId".into(), grant_facts["grantId"].clone());
            target.insert("status".into(), json!(outcome.status));
            target.insert("startedAt".into(), json!(started_at));
            target.insert("endedAt".into(), json!(now()));
        }
        if outcome.not_dispatched {
            result["evidence"]["dispatchOutcome"] = json!("not_dispatched");
        }
        if !additional.is_empty() {
            result["evidence"]["readScopeDecisions"] = json!(additional);
        }
        if command_effect
            && authorization.grant.is_some()
            && authorization.failure.is_none()
            && admission_error.is_none()
            && (!background || outcome.error != Some("shell_task_limit"))
        {
            result["evidence"]["nativeProcess"] =
                json!(budget.read_process(host, &call_id, &dispatch)?);
        }
        if background_started {
            result["evidence"]["permissionGrantId"] = grant_facts["grantId"].clone();
        }
        if foreground_shell
            && let Some(binding) = budget.shell_evidence(host, &call_id, &dispatch)?
        {
            result["evidence"]["shellSession"] = binding;
            result["evidence"]["permissionGrantId"] = grant_facts["grantId"].clone();
        }
        if let Some(error) = outcome.error {
            result["error"] = json!({"code":error,"message":error,"recoverable":true})
        }
        let all_grants = std::iter::once(grant_facts.clone())
            .chain(additional)
            .collect::<Vec<_>>();
        let evidence_store = EvidenceIndexStore::new(&host.home);
        let index = |result: &Value| {
            evidence_store.register(
                &HostToolEvidence {
                    conversation_id: conversation,
                    plan_id: Some(plan_id),
                    stream_id: Some(stream),
                    tool_name: &call.name,
                    capability_id: &capability,
                    tool_call_id: &call_id,
                    grant: &grant_facts,
                    result,
                },
                None,
            )
        };
        let mut archived = None;
        let mut post_error = None;
        let mut post_unknown = None;
        if !selected.post.is_empty()
            && authorization.grant.is_some()
            && (outcome.ended || background_started)
            && !outcome.not_dispatched
            && !cancellation.is_cancelled()
            && !cancel.is_cancelled()
        {
            let startup =
                background_started.then(|| crate::providers::background_start_fields(&result));
            let mut observed = host
                .archive_tool_result(
                    conversation,
                    result.clone(),
                    output_kind,
                    cancellation,
                    cancel,
                )
                .await?;
            crate::providers::restore_background_start_fields(&mut observed, startup)?;
            message
                .as_ref()
                .ok_or(HostError("native_work_hooks_invalid"))?
                .commit(host, &all_grants, Some(&observed))?;
            index(&observed)?;
            archived = Some(observed);
            match run_hooks(
                host,
                frame,
                hook_call(&dispatch),
                &selected.post,
                HookPhase::PostToolUse,
                Some(&result),
            )
            .await
            {
                Ok(after) => {
                    hooks.records.extend(after.records);
                    post_error = after.interrupted;
                }
                Err(error) => post_unknown = Some(error),
            }
        }
        let mut result = match archived {
            Some(result) => result,
            None => {
                let startup =
                    background_started.then(|| crate::providers::background_start_fields(&result));
                let mut result = host
                    .archive_tool_result(conversation, result, output_kind, cancellation, cancel)
                    .await?;
                crate::providers::restore_background_start_fields(&mut result, startup)?;
                result
            }
        };
        if !hooks.records.is_empty() {
            result["evidence"]["hooks"] = json!(hooks.records);
            result["evidence"]["hookFinalDecision"] = json!(decision_name(hooks.decision));
        }
        if let Some(message) = &message {
            message.commit(host, &all_grants, Some(&result))?;
        } else {
            host.append_episode_message(conversation,&json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","content":"","createdAt":now(),"streamId":stream,"segments":[{"type":"tool-call","tool":call.name,"toolCallId":call_id,"args":args,"result":result}],"permissionGrants":all_grants}))?;
        }
        let evidence = index(&result)?;
        if let Some(error) = post_unknown {
            return Err(error);
        }
        if background_started {
            host.confirm_work_background_start(&result, &evidence)?;
        } else {
            budget.settle(host, &call_id, &dispatch, &result, &now())?;
        }
        if let Some(identity) = &outcome.materialization {
            let reference = format!("tool-result://{call_id}");
            if outcome.status != "success"
                || !evidence.iter().any(|e| e["evidenceRef"] == reference)
            {
                return Err(HostError("native_materialization_receipt_invalid"));
            }
            host.resources.confirm_file_materialization(
                &current.resource,
                HostFileMaterialization {
                    host_epoch: epoch,
                    identity,
                    tool_call_id: &call_id,
                },
                &now(),
            )?;
        }
        if (!outcome.ended && !background_started)
            || outcome.error == Some("execution_outcome_unknown")
        {
            return Err(HostError("execution_outcome_unknown"));
        }
        // Expiry/cancellation closes this run after saving the real
        // not-dispatched result. A late stdin answer cannot approve
        // another prompt in the same episode.
        if let Some(error) = permission_terminal.or(post_error) {
            return Err(error);
        }

        Ok(call_id)
    }
    async fn completed(
        &mut self,
        continuation: Option<ModelContinuation>,
        ids: &[String],
    ) -> Result<(), HostError> {
        let committed = ConversationStore::new(&self.host.home).read_committed(
            self.frame.billing.conversation,
            None,
            8 * 1024 * 1024,
        )?;
        let projected = project_history(&committed.history.messages).map_err(HostError)?;
        self.system = None;
        self.pipeline
            .live
            .remember(&projected, ids, continuation)
            .map_err(|e| HostError(e.code))
    }
}
