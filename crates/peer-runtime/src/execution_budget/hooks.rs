use super::*;
use peer_protocol::{
    NativeProcessState as State, NativeWorkHook, NativeWorkHooks, WorkProviderPhase,
};

impl EpisodeBudget {
    pub(crate) fn begin_hook_provider(
        &self,
        host: &mut NativeSessionHost,
        call: &str,
        dispatch: &str,
        grant: &Value,
        at: &str,
    ) -> Result<(), HostError> {
        self.change(host, at, true, |budget| {
            let row = process::row(budget, &self.attempt, call, dispatch)?;
            let hooks = NativeWorkHooks::read(row)
                .map_err(HostError)?
                .ok_or(HostError("native_work_hooks_invalid"))?;
            if hooks.provider_phase != WorkProviderPhase::Prepared
                || hooks
                    .handles
                    .iter()
                    .any(|h| h.process.state != State::Ended || h.observation.is_none())
            {
                return Err(HostError("native_work_hooks_changed"));
            }
            row["nativeHooks"]["providerPhase"] = json!(WorkProviderPhase::Dispatching);
            row["nativeHooks"]["grant"] = grant.clone();
            NativeWorkHooks::read(row).map_err(HostError)?;
            Ok(())
        })
    }

    pub(crate) fn record_hook(
        &self,
        host: &mut NativeSessionHost,
        hook: &NativeWorkHook,
        at: &str,
    ) -> Result<(), HostError> {
        let p = &hook.process;
        self.change(
            host,
            at,
            p.state == State::NotStarted || p.state == State::Starting,
            |budget| {
                let row = process::row(budget, &self.attempt, &p.tool_call_id, &p.dispatch_id)?;
                let mut hooks = NativeWorkHooks::read(row)
                    .map_err(HostError)?
                    .ok_or(HostError("native_work_hooks_invalid"))?;
                if let Some(old) = hooks
                    .handles
                    .iter_mut()
                    .find(|h| h.process.handle_id == p.handle_id)
                {
                    let previous = &old.process;
                    let state = (previous.state, p.state);
                    let next = matches!(
                        state,
                        (State::NotStarted, State::Starting | State::Ended)
                            | (State::Starting, State::Running | State::Ended)
                            | (State::Running, State::Ended)
                    );
                    if !next
                        || old.event != hook.event
                        || old.rule_digest != hook.rule_digest
                        || p.state == State::Ended
                            && (p.generation != previous.generation || p.child != previous.child)
                    {
                        return Err(HostError("native_work_hooks_changed"));
                    }
                    *old = hook.clone();
                } else if p.state == State::NotStarted {
                    hooks.handles.push(hook.clone());
                } else {
                    return Err(HostError("native_work_hooks_changed"));
                }
                row["nativeHooks"] = json!(hooks);
                NativeWorkHooks::read(row).map_err(HostError)?;
                Ok(())
            },
        )
    }
}
