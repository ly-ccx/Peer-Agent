//! Worker adapter for the shared native Hook runner. Its process facts are
//! committed to the original Work dispatch under the existing workspace lease.
use super::super::cognition_host::GoalRequestFrame;
use super::*;
use crate::{
    hook_policy::{HookDecision, HookSelector},
    hook_process::{HookProcessOwner, evidence_record, rule_digest, run_hook},
    recorder,
};
use peer_protocol::{
    BotAccessPolicy, NativeOwnedProcess, NativeProcessKind, NativeProcessState, NativeProcessStop,
    NativeWorkHook,
};
use peer_store::{HookConfig, HookDefinition, HookPhase};

#[derive(Default)]
pub(super) struct SelectedHooks<'a> {
    pub pre: Vec<&'a HookDefinition>,
    pub post: Vec<&'a HookDefinition>,
}

impl<'a> SelectedHooks<'a> {
    pub fn select(
        config: &'a HookConfig,
        capability: &str,
        args: &Value,
    ) -> Result<Self, HostError> {
        let select = |phase| {
            config
                .rules(phase)
                .iter()
                .filter_map(|hook| {
                    match HookSelector::compile(hook)
                        .and_then(|selector| selector.matches(capability, args))
                    {
                        Ok(true) => Some(Ok(hook)),
                        Ok(false) => None,
                        Err(error) => Some(Err(HostError(error))),
                    }
                })
                .collect::<Result<Vec<_>, _>>()
        };
        Ok(Self {
            pre: select(HookPhase::PreToolUse)?,
            post: select(HookPhase::PostToolUse)?,
        })
    }

    pub fn any(&self) -> bool {
        !(self.pre.is_empty() && self.post.is_empty())
    }
}

#[derive(Clone, Copy)]
pub(super) struct WorkHookCall<'a> {
    pub identity: HostCallIdentity<'a>,
    pub tool: &'a str,
    pub args: &'a Value,
    pub projection: &'a str,
    pub dispatch: &'a str,
}

pub(super) struct HookResults {
    pub decision: HookDecision,
    pub records: Vec<Value>,
    pub interrupted: Option<HostError>,
}

impl Default for HookResults {
    fn default() -> Self {
        Self {
            decision: HookDecision::Allow,
            records: vec![],
            interrupted: None,
        }
    }
}

pub(super) async fn run_hooks(
    host: &mut NativeSessionHost,
    frame: &GoalRequestFrame<'_>,
    call: WorkHookCall<'_>,
    rules: &[&HookDefinition],
    phase: HookPhase,
    result: Option<&Value>,
) -> Result<HookResults, HostError> {
    let mut out = HookResults::default();
    if rules.is_empty() {
        return Ok(out);
    }
    let identity = call.identity;
    let revision = host.hook_authority_revision(&identity, call.args)?;
    let mut payload = json!({
        "event":phase.name(),"sessionId":identity.session_id,"projectionId":call.projection,
        "conversationId":identity.conversation_id,
        "call":{"toolCallId":identity.tool_call_id,"capabilityId":identity.capability_id,
            "name":call.tool,"arguments":call.args,"mode":"goal"}
    });
    if let Some(result) = result {
        payload["result"] = result.clone();
    }
    let input = serde_json::to_vec(&payload).map_err(|_| HostError("hook_input_invalid"))?;
    for rule in rules {
        let digest = rule_digest(rule)?;
        let process = NativeOwnedProcess {
            schema_version: 1,
            kind: NativeProcessKind::Command,
            handle_id: format!("hook-{}", uuid::Uuid::new_v4()),
            tool_call_id: identity.tool_call_id.to_owned(),
            dispatch_id: call.dispatch.to_owned(),
            execution: frame.budget.native_recorder["execution"].clone(),
            generation: 0,
            state: NativeProcessState::NotStarted,
            owner: serde_json::from_value(frame.budget.native_recorder["recorder"].clone())
                .map_err(|_| HostError("native_process_owner_unknown"))?,
            child: None,
            stop_observation: None,
        };
        let mut owner = RuleOwner {
            host,
            frame,
            call,
            revision: &revision,
            hook: NativeWorkHook {
                event: phase.name().into(),
                rule_digest: digest,
                process,
                observation: None,
            },
        };
        owner.current()?;
        owner.persist()?;
        let actual = run_hook(
            rule,
            phase,
            frame.workspace,
            &input,
            frame.owned,
            &mut owner,
        )
        .await?;
        if !actual.ended {
            return Err(HostError("execution_outcome_unknown"));
        }
        let record = evidence_record(
            rule,
            phase,
            &owner.hook.rule_digest,
            &owner.hook.process.handle_id,
            &actual,
        );
        owner.hook.process.state = NativeProcessState::Ended;
        owner.hook.process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
        owner.hook.observation = Some(record.clone());
        owner.persist()?;
        #[cfg(feature = "test-fixtures")]
        if phase == HookPhase::PreToolUse {
            owner.crash_fixture("after_pre_observed");
        }
        out.records.push(record);
        out.decision = out.decision.max(actual.verdict.decision);
        out.interrupted = actual.interrupted;
        if out.interrupted.is_some()
            || phase == HookPhase::PreToolUse && out.decision == HookDecision::Deny
        {
            break;
        }
    }
    Ok(out)
}

struct RuleOwner<'a, 'f> {
    host: &'a mut NativeSessionHost,
    frame: &'a GoalRequestFrame<'f>,
    call: WorkHookCall<'a>,
    hook: NativeWorkHook,
    revision: &'a (String, BotAccessPolicy),
}

impl RuleOwner<'_, '_> {
    #[cfg(feature = "test-fixtures")]
    fn crash_fixture(&self, boundary: &str) {
        if self.host.home.join(".native-cli-fixture").is_file()
            && std::env::var("PEER_NATIVE_EPISODE_HOOK_FAULT").as_deref() == Ok(boundary)
        {
            std::process::exit(77);
        }
    }

    fn persist(&mut self) -> Result<(), HostError> {
        self.frame.budget.record_hook(self.host, &self.hook, &now())
    }
}

impl HookProcessOwner for RuleOwner<'_, '_> {
    fn starting(&mut self) -> Result<(), HostError> {
        self.current()?;
        self.hook.process.generation = 1;
        self.hook.process.state = NativeProcessState::Starting;
        self.persist()?;
        #[cfg(feature = "test-fixtures")]
        {
            self.crash_fixture("after_starting");
            if self.hook.event == "PostToolUse" {
                self.crash_fixture("after_post_starting");
            }
        }
        self.current()
    }

    async fn spawned(&mut self, pid: u32) -> Result<(), HostError> {
        let owner = &self.hook.process.owner;
        let child = recorder::process_recorder(pid, &owner.host_id, &owner.acquired_at)
            .await
            .ok_or(HostError("native_process_recorder_unavailable"))?;
        self.hook.process.state = NativeProcessState::Running;
        self.hook.process.child = Some(child);
        self.persist()?;
        self.current()
    }

    fn current(&mut self) -> Result<(), HostError> {
        if self.frame.owned.is_cancelled() || self.frame.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if !self.host.journal.lease().holds()? || self.host.journal.lease().takeover_requested()? {
            return Err(HostError("HOST_LEASE_LOST"));
        }
        let at = milliseconds(&now())?;
        if at.saturating_sub(milliseconds(
            &self.host.journal.lease().record().heartbeat_at,
        )?) >= 5000
        {
            self.host.journal.heartbeat(at)?;
        }
        self.frame
            .hooks
            .check_current()
            .map_err(|_| HostError("native_hook_source_changed"))?;
        if self.host.goals.revision(self.frame.plan)? != self.frame.goal_revision {
            return Err(HostError("execution_revision_stale"));
        }
        let revision = self
            .host
            .hook_authority_revision(&self.call.identity, self.call.args)?;
        if &revision != self.revision {
            return Err(HostError("permission_authority_changed"));
        }
        Ok(())
    }
}
