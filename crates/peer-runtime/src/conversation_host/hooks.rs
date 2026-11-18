//! An ordinary Hook is part of the same projected tool transaction. Its
//! independently owned child never stands in for the Provider's own dispatch.
use super::*;
use crate::{
    hook_policy::{HookDecision, HookSelector, hook_verdict},
    hook_process::{HookObservation, HookProcessOwner, evidence_record, rule_digest, run_hook},
    recorder,
};
use peer_protocol::{NativeOwnedProcess, NativeProcessKind, NativeProcessState, NativeProcessStop};
use peer_store::{ConversationHookRecord, HookDefinition, HookPhase};

pub(super) struct Hooks {
    pub records: Vec<Value>,
    pub decision: HookDecision,
    pub error: Option<HostError>,
    pub ended_interruption: bool,
}
impl Default for Hooks {
    fn default() -> Self {
        Self {
            records: vec![],
            decision: HookDecision::Allow,
            error: None,
            ended_interruption: false,
        }
    }
}

impl Host<'_> {
    pub(super) async fn tool_hooks(
        &mut self,
        phase: HookPhase,
        call: permission::PermissionCall<'_>,
        dispatch: &str,
        result: Option<&Value>,
    ) -> Hooks {
        let config = self.hooks.clone();
        let mut output = Hooks::default();
        for hook in config.rules(phase) {
            let check = HookSelector::compile(hook)
                .and_then(|selector| selector.matches(call.capability, call.args));
            let record = match check {
                Ok(false) => continue,
                Ok(true) => {
                    self.run_tool_hook(phase, call, dispatch, result, hook)
                        .await
                }
                Err(error) => Err(HostError(error)),
            };
            match record {
                Ok((record, decision, interrupted)) => {
                    output.records.push(record);
                    output.decision = output.decision.max(decision);
                    output.error = interrupted;
                    output.ended_interruption = interrupted.is_some();
                    if interrupted.is_some()
                        || phase == HookPhase::PreToolUse && decision == HookDecision::Deny
                    {
                        break;
                    }
                }
                Err(error) => {
                    output.error = Some(error);
                    break;
                }
            }
        }
        output
    }

    async fn run_tool_hook(
        &mut self,
        phase: HookPhase,
        call: permission::PermissionCall<'_>,
        dispatch: &str,
        result: Option<&Value>,
        hook: &HookDefinition,
    ) -> Result<(Value, HookDecision, Option<HostError>), HostError> {
        self.source_current()?;
        let mut payload = json!({
            "event":phase.name(),"sessionId":self.identity.stream_id,"projectionId":self.projection.id(),
            "conversationId":self.identity.conversation_id,
            "call":{"toolCallId":call.call,"capabilityId":call.capability,"name":call.tool,
                "arguments":call.args,"mode":self.mode.as_str()}
        });
        if let Some(result) = result {
            payload["result"] = result.clone();
        }
        let input = serde_json::to_vec(&payload).map_err(|_| HostError("hook_input_invalid"))?;
        let rule_digest = rule_digest(hook)?;
        let owner = self.run.owner().clone();
        let access_revision = self.access.snapshot()?.1;
        let process = NativeOwnedProcess {
            schema_version: 1,
            kind: NativeProcessKind::Command,
            handle_id: format!("hook-{}", uuid::Uuid::new_v4()),
            tool_call_id: call.call.to_owned(),
            dispatch_id: dispatch.to_owned(),
            execution: json!(self.identity),
            generation: 0,
            state: NativeProcessState::NotStarted,
            owner,
            child: None,
            stop_observation: None,
        };
        let workspace = self.workspace.clone();
        let cancel = self.owned.clone();
        let mut owner = RuleHost {
            host: self,
            process,
            phase,
            rule_digest: &rule_digest,
            access_revision,
        };
        owner.persist(None)?;
        let result = run_hook(hook, phase, &workspace, &input, &cancel, &mut owner).await;
        let observed = match result {
            Ok(observed) => observed,
            Err(error) if owner.process.state == NativeProcessState::NotStarted => {
                HookObservation {
                    verdict: hook_verdict(phase, None, b"", Some(error.0), false),
                    exit_code: None,
                    duration_ms: 0,
                    ended: true,
                    interrupted: Some(error),
                }
            }
            Err(error) => return Err(error),
        };
        if !observed.ended {
            return Err(HostError("execution_outcome_unknown"));
        }
        let decision = observed.verdict.decision;
        let record = evidence_record(
            hook,
            phase,
            &rule_digest,
            &owner.process.handle_id,
            &observed,
        );
        owner.process.state = NativeProcessState::Ended;
        owner.process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
        owner.persist(Some(&record))?;
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&owner.host.home, "after_hook_observed");
        Ok((record, decision, observed.interrupted))
    }
}

pub(super) use crate::hook_process::decision_name;

struct RuleHost<'a, 'h> {
    host: &'a mut Host<'h>,
    process: NativeOwnedProcess,
    phase: HookPhase,
    rule_digest: &'a str,
    access_revision: u64,
}
impl RuleHost<'_, '_> {
    fn persist(&mut self, observation: Option<&Value>) -> Result<(), HostError> {
        let receipt = self.host.store.record_conversation_hook(
            &mut self.host.run,
            &ConversationHookRecord {
                process: &self.process,
                event: self.phase,
                rule_digest: self.rule_digest,
                observation,
            },
            &now(),
        )?;
        self.host.publication(receipt)
    }
}
impl HookProcessOwner for RuleHost<'_, '_> {
    fn starting(&mut self) -> Result<(), HostError> {
        self.current()?;
        self.process.generation = 1;
        self.process.state = NativeProcessState::Starting;
        self.persist(None)?;
        self.current()
    }

    async fn spawned(&mut self, pid: u32) -> Result<(), HostError> {
        let owner = &self.process.owner;
        let child = recorder::process_recorder(pid, &owner.host_id, &owner.acquired_at)
            .await
            .ok_or(HostError("native_process_recorder_unavailable"))?;
        self.process.child = Some(child);
        self.process.state = NativeProcessState::Running;
        self.persist(None)?;
        self.current()
    }

    fn current(&mut self) -> Result<(), HostError> {
        if self.host.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        self.host.source_current()?;
        if self.host.access.snapshot()?.1 != self.access_revision {
            return Err(HostError("permission_policy_changed"));
        }
        Ok(())
    }
}
