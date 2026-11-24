//! Durable intent precedes effects; only actual Provider outcomes and local
//! decisions become canonical Tool Result/Grant/Evidence facts.
use super::*;
use crate::{
    capability::ProviderPermission,
    providers::{EffectOutcome, interaction},
    tool_result_content::{ArchivePolicy, archive},
    turn_loop::ToolStep,
};
use peer_protocol::{ConversationDispatchPhase, ConversationPendingTool};
use peer_store::{EvidenceIndexStore, HostToolEvidence};
use sha2::{Digest, Sha256};
impl Host<'_> {
    pub(super) async fn tool(&mut self, call: ModelToolCall) -> Result<ToolStep, HostError> {
        self.source_current()?;
        if let Some(worker) = &mut self.worker {
            worker.admit_tool()?;
        }
        self.reap_background_shells(true).await?;
        let raw_args_for_automation = (self.worker.is_none() && self.automation_policy.is_some())
            .then(|| call.arguments.clone());
        let projection = self
            .worker
            .as_ref()
            .map_or(&self.projection, |worker| &worker.projection);
        let delegated_args = projection
            .has_capability(interaction::PARENT_QUESTION_CAPABILITY)
            .then(|| call.arguments.clone());
        let effect = match self.providers.prepare(
            projection,
            &call.name,
            call.arguments,
            &self.workspace,
            &self.home,
        ) {
            Ok(effect) => effect,
            Err(HostError(risk_error @ ("privileged_command" | "destructive_command")))
                if raw_args_for_automation.is_some()
                    && self.projection.capability(&call.name) == Some("local.shell.exec") =>
            {
                return self
                    .deny_unprepared_tool(
                        &call.name,
                        "local.shell.exec",
                        raw_args_for_automation.expect("checked raw_args_for_automation"),
                        "automation_high_risk_blocked",
                        Some(risk_error),
                    )
                    .await;
            }
            Err(HostError("tool_arguments_invalid"))
                if let Some(args) = delegated_args
                    && let Some(capability) = projection.capability(&call.name) =>
            {
                let capability = capability.to_owned();
                return self
                    .deny_unprepared_tool(
                        &call.name,
                        &capability,
                        args,
                        "tool_arguments_invalid",
                        None,
                    )
                    .await;
            }
            Err(error) => return Err(error),
        };
        let capability = projection
            .capability(&call.name)
            .ok_or(HostError("tool_not_projected"))?
            .to_owned();
        let args = effect.args().clone();
        let scopes = effect.scopes()?;
        let evidence = effect.evidence();
        let kind = effect.output_kind();
        let permission = effect.permission();
        let is_user_input = permission == ProviderPermission::UserInput;
        let input_unavailable = is_user_input && !self.interactive_user_input;
        let goal_intake = self.observe_goal_intake(permission).await?;
        let risk = effect.risk();
        let read_path = if self.worker.is_some() {
            effect.confined_read_scope()?
        } else {
            effect.read_scope()?
        }
        .map(Path::to_owned);
        let (call_id, dispatch, message_id) = self
            .prepare_tool_intent(
                &call.name,
                &capability,
                &args,
                scopes.iter().map(|s| json!(s)).collect(),
            )
            .await?;
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "after_prepared");
        let operation = permission::PermissionCall {
            call: &call_id,
            capability: &capability,
            args: &args,
            tool: &call.name,
        };
        let mut hook =
            if is_user_input || self.worker.is_some() || goal_intake.denial(&self.home).is_some() {
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
        if grant.prompted {
            self.publish(ConversationEvent::PermissionSettled {
                call_id: &call_id,
                granted: grant.facts["granted"] == true,
                reason: grant.facts["reason"].as_str().unwrap_or(""),
            })
            .await?;
        }
        // A real permission fact is canonical before dispatch can be confirmed.
        if grant.facts["granted"] == true {
            self.source_current()?;
            let grants_patch = if self.worker.is_none()
                && let Some(pa) = &mut self.prepared_assistant
            {
                pa.permission_grants.push(grant.facts.clone());
                json!({"permissionGrants": pa.permission_grants})
            } else {
                json!({"permissionGrants":[grant.facts]})
            };
            self.expected = self
                .store
                .commit_terminal_message(&self.expected, &message_id, &grants_patch, &now(), None)?
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
                    } else if input_unavailable {
                        interaction::UNAVAILABLE
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
                    } else if self.automation_policy.is_some()
                        && let Some(reason) = match grant.facts["reason"].as_str() {
                            Some("automation_high_risk_blocked") => {
                                Some("automation_high_risk_blocked")
                            }
                            Some("automation_capability_blocked") => {
                                Some("automation_capability_blocked")
                            }
                            Some("automation_observe_read_only") => {
                                Some("automation_observe_read_only")
                            }
                            Some("automation_capability_not_granted") => {
                                Some("automation_capability_not_granted")
                            }
                            _ => None,
                        }
                    {
                        reason
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
        let observation = if self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.lease.is_verifier())
            && outcome.status == "success"
            && !outcome.not_dispatched
            && outcome.ended
        {
            let facts = serde_json::to_vec(&(&capability, &args, &outcome.output))
                .map_err(|_| HostError("readonly_evidence_invalid"))?;
            Some(format!("{:x}", Sha256::digest(facts)))
        } else {
            None
        };
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
        if is_user_input {
            result["evidence"]["permissionGrantId"] = grant.facts["grantId"].clone();
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
        if self.worker.is_none()
            && !is_user_input
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
        // The first entry is the canonical tool-result reference. Keep just
        // that reference when handing off to a potentially slow output port.
        let evidence_ref = EvidenceIndexStore::new(&self.home)
            .register(
                &HostToolEvidence {
                    conversation_id: &self.identity.conversation_id,
                    plan_id: self.worker.as_ref().map(|worker| worker.lease.plan_id()),
                    stream_id: Some(&self.identity.stream_id),
                    tool_name: &call.name,
                    capability_id: &capability,
                    tool_call_id: &call_id,
                    grant: &grant.facts,
                    result: &result,
                },
                None,
            )?
            .into_iter()
            .next()
            .and_then(|record| record["evidenceRef"].as_str().map(str::to_owned));
        if let Some(error) = hook_unproven {
            return Err(error);
        }
        let settled = ConversationEvent::ToolSettled {
            call_id: &call_id,
            result: &result,
            evidence_ref: evidence_ref.as_deref(),
        };
        if background {
            self.acknowledge_background_start(&call_id)?;
            self.publish(settled).await?;
            if let Some(error) = hook_interrupted.or(grant.terminal) {
                return Err(error);
            }
            return Ok(ToolStep::Continue(call_id));
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
        if let (Some(worker), Some(observation)) = (&mut self.worker, observation) {
            worker.observe(observation);
        }
        self.publish(settled).await?;
        if let Some(error) = interrupted.or(hook_interrupted).or(grant.terminal) {
            return Err(error);
        }
        if self.owned.is_cancelled() || self.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if input_unavailable {
            return Ok(ToolStep::UserInputUnavailable);
        }
        if is_user_input {
            return Ok(ToolStep::RequestedUserInput);
        }
        if capability == crate::providers::interaction::PARENT_QUESTION_CAPABILITY
            && result["status"] == "success"
        {
            return Ok(ToolStep::RequestedParentInput {
                call_id,
                question: args["question"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .to_owned(),
            });
        }
        if outcome.status == "denied" && (self.delegated_verification || self.repairing_goal()) {
            return Err(HostError("permission_denied"));
        }
        Ok(ToolStep::Continue(call_id))
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
        let prepared_mode = self.worker.is_none() && self.prepared_assistant.is_some();
        if !prepared_mode {
            let expected_grants = if grants.first().is_some_and(|g| g["granted"] == true) {
                json!([grants[0]])
            } else {
                json!([])
            };
            // Late outcomes may finish the exact intent whose Grant was persisted
            // before dispatch. Foreign authorization edits cannot be overwritten.
            if row["permissionGrants"] != expected_grants
                && !(original.get("result") == Some(result)
                    && row["permissionGrants"] == json!(grants))
            {
                return Err(HostError("conversation_tool_intent_changed"));
            }
        }
        let mut segments = row["segments"].as_array().unwrap().clone();
        let ended_at_ms = crate::capability::milliseconds(&now()).unwrap_or(0);
        let mut matched = 0;
        for segment in &mut segments {
            if segment["type"] == "tool-call" && segment["toolCallId"] == call {
                matched += 1;
                segment["result"] = result.clone();
                if prepared_mode {
                    segment["endedAtMs"] = json!(ended_at_ms);
                    if let Some(started) = segment["startedAtMs"].as_i64() {
                        segment["durationMs"] = json!((ended_at_ms - started).max(0));
                    }
                }
            }
        }
        if matched != 1 {
            return Err(HostError("conversation_tool_intent_changed"));
        }
        let merged_grants = if self.worker.is_none()
            && let Some(pa) = &mut self.prepared_assistant
        {
            let mut merged = row["permissionGrants"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            for grant in grants {
                let gid = grant.get("grantId").and_then(Value::as_str);
                let already = gid.is_some_and(|id| {
                    merged
                        .iter()
                        .any(|g| g.get("grantId").and_then(Value::as_str) == Some(id))
                });
                if !already {
                    merged.push(grant.clone());
                }
            }
            pa.segments = segments.clone();
            pa.permission_grants = merged.clone();
            Value::Array(merged)
        } else {
            json!(grants)
        };
        self.expected = self
            .store
            .commit_terminal_message(
                &fresh,
                message_id,
                &json!({"segments":segments,"permissionGrants":merged_grants}),
                &now(),
                None,
            )?
            .snapshot;
        Ok(())
    }

    async fn prepare_tool_intent(
        &mut self,
        tool_name: &str,
        capability: &str,
        args: &Value,
        declared_scopes: Vec<Value>,
    ) -> Result<(String, String, String), HostError> {
        let call_id = format!("call-{}", uuid::Uuid::new_v4());
        let dispatch = format!("dispatch-{}", uuid::Uuid::new_v4());
        let started_at_ms = crate::capability::milliseconds(&now()).unwrap_or(0);
        let prepared_mode = self.worker.is_none() && self.prepared_assistant.is_some();
        let message_id = if prepared_mode {
            self.prepared_assistant
                .as_ref()
                .expect("checked prepared_assistant")
                .message_id
                .clone()
        } else {
            format!("message-{}", uuid::Uuid::new_v4())
        };
        if prepared_mode {
            let tool_segment = json!({
                "type": "tool-call",
                "tool": tool_name,
                "toolCallId": call_id,
                "args": args,
                "startedAtMs": started_at_ms,
            });
            let segments_value = {
                let pa = self
                    .prepared_assistant
                    .as_mut()
                    .ok_or(HostError("prepared_assistant_unavailable"))?;
                pa.segments.push(tool_segment);
                json!(pa.segments)
            };
            self.source_current()?;
            self.expected = self
                .store
                .commit_terminal_message(
                    &self.expected,
                    &message_id,
                    &json!({"segments": segments_value, "streamId": self.identity.stream_id}),
                    &now(),
                    None,
                )?
                .snapshot;
        } else {
            self.append(&json!({
                "id": message_id,
                "role": "assistant",
                "content": "",
                "createdAt": now(),
                "streamId": self.identity.stream_id,
                "segments": [{"type": "tool-call", "tool": tool_name, "toolCallId": call_id, "args": args}],
                "permissionGrants": [],
            }))?;
        }
        let receipt = self.store.prepare_conversation_tool(
            &mut self.run,
            &ConversationPendingTool {
                tool_call_id: call_id.clone(),
                dispatch_id: dispatch.clone(),
                message_id: message_id.clone(),
                capability_id: capability.to_owned(),
                args_digest: peer_protocol::approval_args_digest(args)
                    .map_err(|_| HostError("permission_arguments_invalid"))?,
                phase: ConversationDispatchPhase::Prepared,
                declared_scopes,
                native_process: None,
            },
            &now(),
            None,
        )?;
        self.publication(receipt)?;
        self.publish(ConversationEvent::ToolPrepared {
            call_id: &call_id,
            tool: tool_name,
            arguments: args,
        })
        .await?;
        Ok((call_id, dispatch, message_id))
    }

    async fn deny_unprepared_tool(
        &mut self,
        tool_name: &str,
        capability: &str,
        args: Value,
        reason: &'static str,
        risk_error: Option<&'static str>,
    ) -> Result<ToolStep, HostError> {
        let _args_digest = peer_protocol::approval_args_digest(&args)
            .map_err(|_| HostError("permission_arguments_invalid"))?;
        let (call_id, _dispatch, message_id) = self
            .prepare_tool_intent(tool_name, capability, &args, vec![])
            .await?;
        let revision = self.access.snapshot()?.1;
        let mut grant_facts = json!({
            "grantId": format!("grant-{}", uuid::Uuid::new_v4()),
            "toolCallId": call_id,
            "granted": false,
            "scope": capability,
            "duration": "denied",
            "decidedAt": now(),
            "reason": reason,
            "metadata": {
                "policyRevision": format!("ordinary:{}:{revision}", self.identity.stream_id),
            },
        });
        if let Some(risk_error) = risk_error {
            grant_facts["metadata"]["shellRiskError"] = json!(risk_error);
        }
        let result = json!({
            "toolCallId": call_id,
            "capabilityId": capability,
            "status": "denied",
            "output": {},
            "outputPreview": { "kind": "json" },
            "completedAt": now(),
            "error": {
                "code": reason,
                "message": reason,
                "recoverable": true,
            },
            "evidence": {
                "evidenceId": format!("evidence-{}", uuid::Uuid::new_v4()),
                "toolCallId": call_id,
                "permissionGrantId": grant_facts["grantId"],
                "summary": format!("{tool_name}: denied"),
                "artifactRefs": [],
                "dispatchOutcome": "not_dispatched",
            },
        });
        self.tool_facts(
            &message_id,
            &call_id,
            tool_name,
            &args,
            &result,
            std::slice::from_ref(&grant_facts),
        )?;
        let evidence_ref = EvidenceIndexStore::new(&self.home)
            .register(
                &HostToolEvidence {
                    conversation_id: &self.identity.conversation_id,
                    plan_id: None,
                    stream_id: Some(&self.identity.stream_id),
                    tool_name,
                    capability_id: capability,
                    tool_call_id: &call_id,
                    grant: &grant_facts,
                    result: &result,
                },
                None,
            )?
            .into_iter()
            .next()
            .and_then(|record| record["evidenceRef"].as_str().map(str::to_owned));
        let receipt =
            self.store
                .settle_conversation_tool(&mut self.run, &call_id, &message_id, &now())?;
        if let Err(error) = self.publication(receipt) {
            self.owned.cancel();
            return Err(error);
        }
        self.publish(ConversationEvent::ToolSettled {
            call_id: &call_id,
            result: &result,
            evidence_ref: evidence_ref.as_deref(),
        })
        .await?;
        if self.owned.is_cancelled() || self.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        Ok(ToolStep::Continue(call_id))
    }
}
