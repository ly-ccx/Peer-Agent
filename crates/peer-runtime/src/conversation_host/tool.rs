//! Durable intent precedes effects; only actual Provider outcomes and local
//! decisions become canonical Tool Result/Grant/Evidence facts.
use super::*;
use crate::{
    providers::EffectOutcome,
    tool_result_content::{ArchivePolicy, archive},
};
use peer_protocol::{ConversationDispatchPhase, ConversationPendingTool};
use peer_store::{EvidenceIndexStore, HostToolEvidence};
impl Host<'_> {
    pub(super) async fn tool(&mut self, call: ModelToolCall) -> Result<String, HostError> {
        self.source_current()?;
        if let Some(worker) = &mut self.explorer {
            if worker.calls >= peer_store::EXPLORER_TOOL_LIMIT {
                return Err(HostError("explorer_tool_limit"));
            }
            worker.calls += 1;
        }
        self.reap_background_shells(true).await?;
        let projection = self
            .explorer
            .as_ref()
            .map_or(&self.projection, |worker| &worker.projection);
        let effect = self.providers.prepare(
            projection,
            &call.name,
            call.arguments,
            &self.workspace,
            &self.home,
        )?;
        let capability = projection
            .capability(&call.name)
            .ok_or(HostError("tool_not_projected"))?
            .to_owned();
        let call_id = format!("call-{}", uuid::Uuid::new_v4());
        let dispatch = format!("dispatch-{}", uuid::Uuid::new_v4());
        let message_id = format!("message-{}", uuid::Uuid::new_v4());
        let args = effect.args().clone();
        let scopes = effect.scopes()?;
        let evidence = effect.evidence();
        let kind = effect.output_kind();
        let permission = effect.permission();
        let goal_intake = self.observe_goal_intake(permission).await?;
        let risk = effect.risk();
        let read_path = if self.explorer.is_some() {
            effect.confined_read_scope()?
        } else {
            effect.read_scope()?
        }
        .map(Path::to_owned);
        self.append(&json!({"id":message_id,"role":"assistant","content":"","createdAt":now(),"streamId":self.identity.stream_id,"segments":[{"type":"tool-call","tool":call.name,"toolCallId":call_id,"args":args}],"permissionGrants":[]}))?;
        let receipt = self.store.prepare_conversation_tool(
            &mut self.run,
            &ConversationPendingTool {
                tool_call_id: call_id.clone(),
                dispatch_id: dispatch.clone(),
                message_id: message_id.clone(),
                capability_id: capability.clone(),
                args_digest: peer_protocol::approval_args_digest(&args)
                    .map_err(|_| HostError("permission_arguments_invalid"))?,
                phase: ConversationDispatchPhase::Prepared,
                declared_scopes: scopes.iter().map(|s| json!(s)).collect(),
                native_process: None,
            },
            &now(),
            None,
        )?;
        self.publication(receipt)?;
        self.publish(ConversationEvent::ToolPrepared {
            call_id: &call_id,
            tool: &call.name,
        })
        .await?;
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "after_prepared");
        let operation = permission::PermissionCall {
            call: &call_id,
            capability: &capability,
            args: &args,
            tool: &call.name,
        };
        let mut hook = if self.explorer.is_some() || goal_intake.denial(&self.home).is_some() {
            hooks::Hooks::default()
        } else {
            self.tool_hooks(
                peer_store::HookPhase::PreToolUse,
                operation,
                &dispatch,
                None,
            )
            .await
        };
        if let Some(error) = hook.error
            && !hook.ended_interruption
        {
            return Err(error);
        }
        let read_path = if hook.ended_interruption {
            None
        } else {
            read_path
        };
        let mut grant = self
            .authorize(
                operation,
                permission,
                risk,
                read_path,
                (hook.decision, hook.error),
                goal_intake,
            )
            .await?;
        // A real permission fact is canonical before dispatch can be confirmed.
        if grant.facts["granted"] == true {
            self.source_current()?;
            self.expected = self
                .store
                .commit_terminal_message(
                    &self.expected,
                    &message_id,
                    &json!({"permissionGrants":[grant.facts]}),
                    &now(),
                    None,
                )?
                .snapshot;
        }
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "after_grant");
        let (outcome, interrupted, background) = if grant.facts["granted"] == true {
            let receipt =
                self.store
                    .dispatch_conversation_tool(&mut self.run, &call_id, &now(), None)?;
            self.publication(receipt)?;
            self.launch(effect, &mut grant, &dispatch).await?
        } else {
            (
                EffectOutcome {
                    status: if grant.terminal == Some(HostError("CANCELLED")) {
                        "cancelled"
                    } else {
                        "denied"
                    },
                    output: json!({}),
                    error: Some(if hook.ended_interruption {
                        hook.error
                            .map(|error| error.0)
                            .unwrap_or("hook_interrupted")
                    } else if let Some(reason) = grant.goal_denial {
                        reason
                    } else if hook.decision == crate::hook_policy::HookDecision::Deny {
                        "hook_denied"
                    } else if hook.decision == crate::hook_policy::HookDecision::Ask
                        && grant.facts["reason"] == "tui_approval_unavailable"
                    {
                        "hook_approval_required"
                    } else if hook.decision == crate::hook_policy::HookDecision::Ask
                        && grant.facts["reason"] == "denied_in_tui"
                    {
                        "hook_approval_denied"
                    } else {
                        "permission_denied"
                    }),
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: true,
                },
                None,
                false,
            )
        };
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "after_effect");
        let mut result = json!({"toolCallId":call_id,"capabilityId":capability,"status":outcome.status,"output":outcome.output,"outputPreview":{"kind":"json"},"completedAt":now(),"evidence":{"evidenceId":format!("evidence-{}",uuid::Uuid::new_v4()),"toolCallId":call_id,"summary":format!("{}: {}",call.name,outcome.status),"artifactRefs":outcome.artifacts}});
        if let Some(extra) = evidence {
            result["evidence"]
                .as_object_mut()
                .ok_or(HostError("evidence_invalid"))?
                .extend(
                    extra
                        .as_object()
                        .ok_or(HostError("evidence_invalid"))?
                        .clone(),
                );
            result["evidence"]["permissionGrantId"] = grant.facts["grantId"].clone();
            result["evidence"]["status"] = json!(outcome.status);
        }
        if outcome.not_dispatched {
            result["evidence"]["dispatchOutcome"] = json!("not_dispatched");
        }
        if !grant.additional.is_empty() {
            result["evidence"]["readScopeDecisions"] = json!(grant.additional);
        }
        if let Some(process) = self
            .store
            .read_conversation_execution(&self.identity.conversation_id)?
            .and_then(|r| {
                r.pending_tools
                    .into_iter()
                    .find(|p| p.tool_call_id == call_id)
            })
            .and_then(|p| p.native_process)
        {
            result["evidence"]["nativeProcess"] = json!(process);
        }
        if let Some(binding) = self.foreground_shell_evidence(&call_id, &dispatch)? {
            result["evidence"]["shellSession"] = binding;
            result["evidence"]["permissionGrantId"] = grant.facts["grantId"].clone();
        }
        if let Some(error) = outcome.error {
            result["error"] = json!({"code":error,"message":error,"recoverable":true});
        }
        let mut hook_interrupted = None;
        let mut hook_unproven = None;
        if self.explorer.is_none()
            && grant.facts["granted"] == true
            && (outcome.ended || background)
            && !outcome.not_dispatched
            && interrupted.is_none()
            && !self.owned.is_cancelled()
            && !self.external.is_cancelled()
        {
            let after = self
                .tool_hooks(
                    peer_store::HookPhase::PostToolUse,
                    operation,
                    &dispatch,
                    Some(&result),
                )
                .await;
            hook.records.extend(after.records);
            if after.ended_interruption {
                hook_interrupted = after.error;
            } else {
                hook_unproven = after.error;
            }
        }
        if !hook.records.is_empty() {
            result["evidence"]["hooks"] = json!(hook.records);
            result["evidence"]["hookFinalDecision"] = json!(hooks::decision_name(hook.decision));
        }
        let home = self.home.clone();
        let conversation = self.identity.conversation_id.clone();
        // Effect completion has already been observed. Content publication is a
        // separately owned task; caller cancellation cannot discard its result.
        let task = tokio::task::spawn_blocking(move || {
            let shell_start =
                background.then(|| crate::providers::background_start_fields(&result));
            let mut result = archive(
                &home,
                &conversation,
                result,
                kind,
                ArchivePolicy::LargeOnly,
                &CancellationToken::new(),
            )?;
            crate::providers::restore_background_start_fields(&mut result, shell_start)
                .map_err(|error| error.0)?;
            Ok::<_, &'static str>(result)
        });
        let result = task
            .await
            .map_err(|_| HostError("artifact_unavailable"))?
            .map_err(HostError)?;
        let all_grants = std::iter::once(grant.facts.clone())
            .chain(grant.additional.clone())
            .collect::<Vec<_>>();
        self.tool_facts(
            &message_id,
            &call_id,
            &call.name,
            &args,
            &result,
            &all_grants,
        )?;
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "after_tool_facts");
        EvidenceIndexStore::new(&self.home).register(
            &HostToolEvidence {
                conversation_id: &self.identity.conversation_id,
                plan_id: self
                    .explorer
                    .as_ref()
                    .map(|worker| worker.lease.plan.as_str()),
                stream_id: Some(&self.identity.stream_id),
                tool_name: &call.name,
                capability_id: &capability,
                tool_call_id: &call_id,
                grant: &grant.facts,
                result: &result,
            },
            None,
        )?;
        if let Some(error) = hook_unproven {
            return Err(error);
        }
        if background {
            self.acknowledge_background_start(&call_id)?;
            self.publish(ConversationEvent::ToolSettled {
                call_id: &call_id,
                status: outcome.status,
            })
            .await?;
            if let Some(error) = hook_interrupted.or(grant.terminal) {
                return Err(error);
            }
            return Ok(call_id);
        }
        if !outcome.ended || outcome.error == Some("execution_outcome_unknown") {
            return Err(HostError("execution_outcome_unknown"));
        }
        let receipt =
            self.store
                .settle_conversation_tool(&mut self.run, &call_id, &message_id, &now())?;
        if let Err(error) = self.publication(receipt) {
            self.owned.cancel();
            return Err(error);
        }
        self.publish(ConversationEvent::ToolSettled {
            call_id: &call_id,
            status: outcome.status,
        })
        .await?;
        if let Some(error) = interrupted.or(hook_interrupted).or(grant.terminal) {
            return Err(error);
        }
        if self.owned.is_cancelled() || self.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        Ok(call_id)
    }
    fn tool_facts(
        &mut self,
        message_id: &str,
        call: &str,
        tool: &str,
        args: &Value,
        result: &Value,
        grants: &[Value],
    ) -> Result<(), HostError> {
        let fresh =
            self.store
                .read_committed(&self.identity.conversation_id, None, 8 * 1024 * 1024)?;
        // Accept only a late factual update to this exact owned intent. This
        // cannot rebase cognition or authorize another effect after foreign input.
        if fresh.source_revision != self.expected.source_revision {
            self.owned.cancel();
        }
        let row = fresh
            .history
            .messages
            .iter()
            .find(|m| m["id"] == message_id)
            .ok_or(HostError("conversation_tool_intent_changed"))?;
        let original = row["segments"]
            .as_array()
            .and_then(|s| {
                s.iter()
                    .find(|s| s["type"] == "tool-call" && s["toolCallId"] == call)
            })
            .ok_or(HostError("conversation_tool_intent_changed"))?;
        if row["role"] != "assistant"
            || row["streamId"] != self.identity.stream_id
            || original["args"] != *args
            || original["tool"] != tool
            || original.get("result").is_some_and(|r| r != result)
        {
            return Err(HostError("conversation_tool_intent_changed"));
        }
        let expected_grants = if grants.first().is_some_and(|g| g["granted"] == true) {
            json!([grants[0]])
        } else {
            json!([])
        };
        // Late outcomes may finish the exact intent whose Grant was persisted
        // before dispatch. Foreign authorization edits cannot be overwritten.
        if row["permissionGrants"] != expected_grants
            && !(original.get("result") == Some(result) && row["permissionGrants"] == json!(grants))
        {
            return Err(HostError("conversation_tool_intent_changed"));
        }
        let mut segments = row["segments"].as_array().unwrap().clone();
        let mut matched = 0;
        for segment in &mut segments {
            if segment["type"] == "tool-call" && segment["toolCallId"] == call {
                matched += 1;
                segment["result"] = result.clone();
            }
        }
        if matched != 1 {
            return Err(HostError("conversation_tool_intent_changed"));
        }
        self.expected = self
            .store
            .commit_terminal_message(
                &fresh,
                message_id,
                &json!({"segments":segments,"permissionGrants":grants}),
                &now(),
                None,
            )?
            .snapshot;
        Ok(())
    }
}
