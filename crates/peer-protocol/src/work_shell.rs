//! Delegated Shell ownership lives in its original Work attempt. Validation
//! retains the provenance of an unsettled call without deciding its effects.
use crate::{
    NativeProcessState as State, NativeShellCommandBinding, NativeShellSession,
    normalize_native_episode_recorder, normalize_session_execution_identity,
};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const WORK_SHELL_SEMANTIC_FLOOR: u64 = 15;
const INVALID: &str = "native_work_shell_invalid";

pub struct NativeWorkShellSession<'a> {
    pub attempt_id: &'a str,
    pub session: NativeShellSession,
}

fn text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.is_empty() && s.len() <= 512 && !s.chars().any(char::is_control))
}

fn shell_dispatch(row: &Value, call: &str, dispatch: &str) -> bool {
    row["toolCallId"] == call
        && row["dispatchId"] == dispatch
        && row["capabilityId"] == "local.shell.exec"
        && row.get("nativeProcess").is_none()
}

fn grant_matches(row: &Value) -> bool {
    shell_grant_matches(row, &row["nativeShellGrant"])
}

fn shell_grant_matches(row: &Value, grant: &Value) -> bool {
    grant.as_object().is_some_and(|object| object.len() == 8)
        && text(&grant["grantId"])
        && grant["toolCallId"] == row["toolCallId"]
        && grant["granted"] == true
        && grant["scope"] == "local.shell.exec"
        && grant["duration"] == "once"
        && text(&grant["decidedAt"])
        && text(&grant["reason"])
        && text(&grant["policyRevision"])
        && row["nativeHooks"]
            .get("grant")
            .is_none_or(|hook_grant| hook_grant == grant)
}

fn pending(attempt: &Value) -> impl Iterator<Item = &Value> {
    attempt["pendingTools"].as_array().into_iter().flatten()
}

pub fn native_work_shell_sessions(
    work: &Value,
) -> Result<Vec<NativeWorkShellSession<'_>>, &'static str> {
    let budget = &work["budget"];
    let uncertain = || {
        budget["uncertainDispatches"]
            .as_array()
            .into_iter()
            .flatten()
    };
    for row in uncertain().filter(|row| row.get("nativeShellGrant").is_some()) {
        let recorder = &row["nativeRecorder"];
        let execution =
            normalize_session_execution_identity(&recorder["execution"]).ok_or(INVALID)?;
        if !text(&row["attemptId"])
            || !text(&row["toolCallId"])
            || !text(&row["dispatchId"])
            || !shell_dispatch(
                row,
                row["toolCallId"].as_str().ok_or(INVALID)?,
                row["dispatchId"].as_str().ok_or(INVALID)?,
            )
            || row["role"] != "work_session"
            || row["planId"] != execution.plan_id
            || row["sessionId"] != execution.session_id
            || normalize_native_episode_recorder(recorder, &execution).is_none()
            || !grant_matches(row)
        {
            return Err(INVALID);
        }
    }
    let mut sessions = Vec::new();
    let mut handles = HashSet::new();
    let mut executions = HashSet::new();
    for (id, attempt) in budget["attempts"].as_object().into_iter().flatten() {
        let Some(raw) = attempt.get("nativeShellSession") else {
            if pending(attempt).any(|row| row.get("nativeShellGrant").is_some()) {
                return Err(INVALID);
            }
            continue;
        };
        let session = NativeShellSession::from_record(raw).ok_or(INVALID)?;
        let process = &session.process;
        let execution = normalize_session_execution_identity(&process.execution).ok_or(INVALID)?;
        let recorder = &attempt["nativeRecorder"];
        let dispatches =
            || pending(attempt).chain(uncertain().filter(|row| row["attemptId"] == id.as_str()));
        if id.is_empty()
            || attempt["role"] != "work_session"
            || attempt["planId"] != execution.plan_id
            || attempt["sessionId"] != execution.session_id
            || normalize_native_episode_recorder(recorder, &execution).is_none()
            || recorder["recorder"] != json!(process.owner)
            || !handles.insert(process.handle_id.clone())
            || !executions.insert((execution.plan_id, execution.session_id))
            || matches!(process.state, State::NotStarted | State::Starting)
                && dispatches()
                    .filter(|row| {
                        shell_dispatch(row, &process.tool_call_id, &process.dispatch_id)
                            && row["nativeRecorder"] == *recorder
                    })
                    .count()
                    != 1
        {
            return Err(INVALID);
        }
        if let Some(command) = &session.command
            && dispatches()
                .filter(|row| {
                    shell_dispatch(row, &command.tool_call_id, &command.dispatch_id)
                        && row["nativeRecorder"] == *recorder
                        && grant_matches(row)
                })
                .count()
                != 1
        {
            return Err(INVALID);
        }
        if pending(attempt)
            .filter(|row| row.get("nativeShellGrant").is_some())
            .any(|row| {
                session.command.as_ref().is_none_or(|command| {
                    !shell_dispatch(row, &command.tool_call_id, &command.dispatch_id)
                        || row["nativeRecorder"] != *recorder
                        || !grant_matches(row)
                })
            })
        {
            return Err(INVALID);
        }
        sessions.push(NativeWorkShellSession {
            attempt_id: id,
            session,
        });
    }
    Ok(sessions)
}

struct WorkBackgroundShell<'a> {
    attempt: &'a str,
    process: crate::NativeOwnedProcess,
    grant: &'a Value,
    startup: Option<&'a Value>,
    pending: bool,
}

fn work_background_shells(work: &Value) -> Result<Vec<WorkBackgroundShell<'_>>, &'static str> {
    let budget = &work["budget"];
    let active = budget["attempts"]
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(id, attempt)| {
            pending(attempt).map(move |row| (id.as_str(), attempt, row, true))
        });
    let uncertain = budget["uncertainDispatches"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|row| (row["attemptId"].as_str().unwrap_or(""), row, row, false));
    let mut shells = Vec::new();
    for (attempt_id, attempt, row, pending) in active.chain(uncertain) {
        let Some(background) = row.get("nativeBackgroundShell") else {
            continue;
        };
        let process: crate::NativeOwnedProcess =
            serde_json::from_value(row["nativeProcess"].clone()).map_err(|_| INVALID)?;
        let execution = normalize_session_execution_identity(&process.execution).ok_or(INVALID)?;
        let startup = background.get("startup");
        let grant = &background["grant"];
        if background
            .as_object()
            .is_none_or(|fields| fields.len() != 2 + usize::from(startup.is_some()))
            || background["schemaVersion"] != 1
            || attempt_id.is_empty()
            || attempt["role"] != "work_session"
            || attempt["planId"] != execution.plan_id
            || attempt["sessionId"] != execution.session_id
            || row["nativeRecorder"] != attempt["nativeRecorder"]
            || normalize_native_episode_recorder(&row["nativeRecorder"], &execution).is_none()
            || row["nativeRecorder"]["recorder"] != json!(process.owner)
            || !process.valid()
            || !crate::shell_task_id_valid(&process.handle_id)
            || row["toolCallId"] != process.tool_call_id
            || row["dispatchId"] != process.dispatch_id
            || row["capabilityId"] != "local.shell.exec"
            || row.get("nativeShellGrant").is_some()
            || !shell_grant_matches(row, grant)
            || startup.is_some_and(|value| !valid_background_startup(value, &process))
            || shells.len() >= 128
        {
            return Err(INVALID);
        }
        shells.push(WorkBackgroundShell {
            attempt: attempt_id,
            process,
            grant,
            startup,
            pending,
        });
    }
    if !shells.is_empty() {
        crate::native_processes_in_work(work)?;
    }
    Ok(shells)
}

fn valid_background_startup(startup: &Value, process: &crate::NativeOwnedProcess) -> bool {
    let tool_result = format!("tool-result://{}", process.tool_call_id);
    let reference = format!("local-shell-artifact://{}", process.handle_id);
    matches!(process.state, State::Running | State::Ended)
        && process.child.is_some()
        && startup.as_object().is_some_and(|fields| fields.len() == 2)
        && text(&startup["evidenceId"])
        && startup["evidenceRefs"].as_array().is_some_and(|refs| {
            refs.len() <= 8
                && refs.first().is_some_and(|value| value == &tool_result)
                && refs.iter().all(text)
                && ["stdout", "stderr", "metadata"].into_iter().all(|name| {
                    let artifact = format!("{reference}/{name}");
                    refs.iter().any(|value| value == &artifact)
                })
        })
}

fn validate_work_background_change(before: &Value, after: &Value) -> Result<(), &'static str> {
    let previous = work_background_shells(before)?;
    let current = work_background_shells(after)?;
    for old in &previous {
        let p = &old.process;
        if let Some(new) = current
            .iter()
            .find(|new| new.process.dispatch_id == p.dispatch_id)
        {
            let n = &new.process;
            if new.attempt != old.attempt
                || new.grant != old.grant
                || n.tool_call_id != p.tool_call_id
                || n.handle_id != p.handle_id
                || n.execution != p.execution
                || n.owner != p.owner
                || (!old.pending && new.pending)
                || (old.startup.is_some() && new.startup != old.startup)
            {
                return Err(INVALID);
            }
            let same_child_generation = p.child == n.child && p.generation == n.generation;
            let next = match (p.state, n.state) {
                (State::NotStarted, State::Starting) => n.generation == 1,
                (State::Starting, State::Running) => n.generation == p.generation,
                (State::NotStarted | State::Starting | State::Running, State::Ended) => {
                    same_child_generation
                }
                _ => p == n,
            };
            if !next
                || old.startup.is_none()
                    && new.startup.is_some()
                    && (!new.pending || p != n || n.state != State::Running)
            {
                return Err(INVALID);
            }
        } else {
            let budget = &after["budget"];
            let receipt = budget["attempts"][old.attempt]["settledTools"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(budget["dispatchReceipts"].get(&p.dispatch_id))
                .find(|row| {
                    row["dispatchId"] == p.dispatch_id && row["toolCallId"] == p.tool_call_id
                });
            if p.state != State::Ended
                || receipt.is_none_or(|row| {
                    old.startup.is_some_and(|startup| {
                        row["outcome"] != "resulted"
                            || row["evidenceRefs"] != startup["evidenceRefs"]
                    })
                })
            {
                return Err(INVALID);
            }
        }
    }
    if current.iter().any(|new| {
        !previous
            .iter()
            .any(|old| old.process.dispatch_id == new.process.dispatch_id)
            && (!new.pending || new.process.state != State::NotStarted || new.startup.is_some())
    }) {
        return Err(INVALID);
    }
    Ok(())
}

pub fn native_work_has_shell_facts(work: &Value) -> Result<bool, &'static str> {
    Ok(!work_background_shells(work)?.is_empty()
        || !native_work_shell_sessions(work)?.is_empty()
        || work["budget"]["uncertainDispatches"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row.get("nativeShellGrant").is_some()))
}

fn bound_grant<'a>(
    work: &'a Value,
    attempt: &str,
    binding: &NativeShellCommandBinding,
) -> Option<&'a Value> {
    let budget = &work["budget"];
    pending(&budget["attempts"][attempt])
        .chain(
            budget["uncertainDispatches"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| row["attemptId"] == attempt),
        )
        .find(|row| shell_dispatch(row, &binding.tool_call_id, &binding.dispatch_id))
        .and_then(|row| row.get("nativeShellGrant"))
}

pub fn validate_native_work_shell_change(
    before: &Value,
    after: &Value,
) -> Result<(), &'static str> {
    validate_work_background_change(before, after)?;
    let previous = native_work_shell_sessions(before)?;
    let current = native_work_shell_sessions(after)?;
    for old in &previous {
        let Some(new) = current.iter().find(|new| new.attempt_id == old.attempt_id) else {
            if old.session.process.state != State::Ended {
                return Err(INVALID);
            }
            continue;
        };
        let p = &old.session.process;
        let n = &new.session.process;
        if p.handle_id != n.handle_id
            || p.tool_call_id != n.tool_call_id
            || p.dispatch_id != n.dispatch_id
            || p.owner != n.owner
            || p.execution != n.execution
        {
            return Err(INVALID);
        }
        let same_child = n.child == p.child;
        let transition = match (p.state, n.state) {
            (State::NotStarted, State::Starting) => n.generation == 1,
            (State::Starting, State::Running) => n.generation == p.generation,
            (State::NotStarted | State::Starting | State::Running, State::Ended) => {
                n.generation == p.generation
                    && same_child
                    && new.session.command == old.session.command
            }
            _ => p == n,
        };
        if !transition {
            return Err(INVALID);
        }
        if let Some(command) = &old.session.command
            && new.session.command.as_ref() == Some(command)
            && bound_grant(before, old.attempt_id, command)
                != bound_grant(after, old.attempt_id, command)
        {
            return Err(INVALID);
        }
        if let Some(command) = &old.session.command
            && new.session.command.as_ref() != Some(command)
        {
            // Completion drops the grant-bearing pending row and preserves a
            // receipt for the same dispatch. No change can swap bindings.
            let attempt = &after["budget"]["attempts"][old.attempt_id];
            let settled = attempt["settledTools"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(after["budget"]["dispatchReceipts"].get(&command.dispatch_id))
                .any(|row| {
                    row["dispatchId"] == command.dispatch_id
                        && row["toolCallId"] == command.tool_call_id
                        && matches!(
                            row["outcome"].as_str(),
                            Some("resulted" | "terminated" | "not_dispatched")
                        )
                });
            if new.session.command.is_some() || n.state != State::Running || !settled {
                return Err(INVALID);
            }
        }
        // An ended actor cannot accept a new binding or change its grant.
        if n.state == State::Ended && new.session.command != old.session.command {
            return Err(INVALID);
        }
    }
    if current.iter().any(|new| {
        !previous.iter().any(|old| old.attempt_id == new.attempt_id)
            && new.session.process.state != State::NotStarted
    }) {
        return Err(INVALID);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work() -> Value {
        let execution = json!({"planId":"plan","sessionId":"session","executionEpoch":"epoch"});
        let owner =
            json!({"pid":41,"pidStart":"start","hostId":"host","bootId":"boot","acquiredAt":"at"});
        let recorder = json!({"schemaVersion":1,"runtime":"peer-native","execution":execution,"recorder":owner});
        json!({"workId":"work","budget":{"attempts":{"attempt":{
            "role":"work_session","planId":"plan","sessionId":"session","nativeRecorder":recorder,
            "pendingTools":[{"toolCallId":"call","dispatchId":"dispatch","capabilityId":"local.shell.exec","nativeRecorder":recorder}],
            "nativeShellSession":{"schemaVersion":1,"command":null,"process":{
                "schemaVersion":1,"kind":"command","handleId":"shell-session_12345678-1234-4abc-8def-123456789012",
                "toolCallId":"call","dispatchId":"dispatch","execution":execution,
                "generation":0,"state":"not_started","owner":owner
            }}
        }}}})
    }

    fn attempt(value: &mut Value) -> &mut Value {
        &mut value["budget"]["attempts"]["attempt"]
    }

    fn running() -> Value {
        let created = work();
        let mut starting = created.clone();
        let shell = &mut attempt(&mut starting)["nativeShellSession"];
        shell["process"]["generation"] = json!(1);
        shell["process"]["state"] = json!("starting");
        assert_eq!(
            validate_native_work_shell_change(&created, &starting),
            Ok(())
        );
        let mut running = starting.clone();
        let proc = &mut attempt(&mut running)["nativeShellSession"]["process"];
        proc["state"] = json!("running");
        proc["child"] = proc["owner"].clone();
        proc["child"]["pid"] = json!(42);
        assert_eq!(
            validate_native_work_shell_change(&starting, &running),
            Ok(())
        );
        running
    }

    fn bind(work: &mut Value) {
        let row = attempt(work);
        row["nativeShellSession"]["command"] =
            json!({"toolCallId":"call","dispatchId":"dispatch","generation":1});
        row["pendingTools"][0]["nativeShellGrant"] = json!({
            "grantId":"original","toolCallId":"call","granted":true,"scope":"local.shell.exec",
            "duration":"once","decidedAt":"at","reason":"policy","policyRevision":"revision"
        });
    }

    #[test]
    fn work_shell_cannot_drop_a_live_interpreter_or_replace_an_original_binding_grant() {
        let mut bound = running();
        bind(&mut bound);
        assert_eq!(
            validate_native_work_shell_change(&running(), &bound),
            Ok(())
        );
        let mut changed = bound.clone();
        attempt(&mut changed)["pendingTools"][0]["nativeShellGrant"]["grantId"] = json!("forged");
        assert_eq!(
            validate_native_work_shell_change(&bound, &changed),
            Err(INVALID)
        );
        let mut missing = bound.clone();
        missing["budget"]["attempts"] = json!({});
        assert_eq!(
            validate_native_work_shell_change(&bound, &missing),
            Err(INVALID)
        );
        attempt(&mut bound)["nativeShellSession"]["command"]["generation"] = json!(2);
        assert!(native_work_shell_sessions(&bound).is_err());
    }

    #[test]
    fn work_shell_only_clears_a_known_binding_or_keeps_original_grant_after_unknown_stop() {
        let mut bound = running();
        bind(&mut bound);
        let mut certified = bound.clone();
        let row = attempt(&mut certified);
        row["nativeShellSession"]["command"] = Value::Null;
        row["pendingTools"] = json!([]);
        assert_eq!(
            validate_native_work_shell_change(&bound, &certified),
            Err(INVALID)
        );
        attempt(&mut certified)["settledTools"] =
            json!([{"toolCallId":"call","dispatchId":"dispatch","outcome":"resulted"}]);
        assert_eq!(
            validate_native_work_shell_change(&bound, &certified),
            Ok(())
        );

        let mut unknown = bound.clone();
        let row = attempt(&mut unknown);
        let mut pending = row["pendingTools"][0].clone();
        pending["attemptId"] = json!("attempt");
        pending["role"] = json!("work_session");
        pending["planId"] = json!("plan");
        pending["sessionId"] = json!("session");
        row["pendingTools"] = json!([]);
        unknown["budget"]["uncertainDispatches"] = json!([pending]);
        assert_eq!(validate_native_work_shell_change(&bound, &unknown), Ok(()));
        let mut ended = unknown.clone();
        let process = &mut attempt(&mut ended)["nativeShellSession"]["process"];
        process["state"] = json!("ended");
        process["stopObservation"] = json!("owner_dead_group_absent");
        assert_eq!(validate_native_work_shell_change(&unknown, &ended), Ok(()));
        let mut retired = ended.clone();
        retired["budget"]["attempts"] = json!({});
        assert_eq!(validate_native_work_shell_change(&ended, &retired), Ok(()));
        assert_eq!(native_work_has_shell_facts(&retired), Ok(true));
    }

    #[test]
    fn work_background_startup_keeps_its_original_grant_evidence_and_stop_boundary() {
        let mut initial = work();
        bind(&mut initial);
        let attempt_record = attempt(&mut initial);
        let mut process = attempt_record
            .as_object_mut()
            .unwrap()
            .shift_remove("nativeShellSession")
            .unwrap()["process"]
            .clone();
        let handle = "shell_12345678-1234-4abc-8def-123456789012";
        process["handleId"] = json!(handle);
        let row = &mut attempt_record["pendingTools"][0];
        let grant = row
            .as_object_mut()
            .unwrap()
            .shift_remove("nativeShellGrant")
            .unwrap();
        row["nativeProcess"] = process;
        row["nativeBackgroundShell"] = json!({"schemaVersion":1,"grant":grant});
        assert_eq!(native_work_has_shell_facts(&initial), Ok(true));
        assert_eq!(
            validate_native_work_shell_change(&Value::Null, &initial),
            Ok(())
        );
        let mut starting = initial.clone();
        let process = &mut attempt(&mut starting)["pendingTools"][0]["nativeProcess"];
        process["state"] = json!("starting");
        process["generation"] = json!(1);
        assert_eq!(
            validate_native_work_shell_change(&initial, &starting),
            Ok(())
        );
        let mut running = starting.clone();
        let process = &mut attempt(&mut running)["pendingTools"][0]["nativeProcess"];
        process["child"] = process["owner"].clone();
        process["child"]["pid"] = json!(42);
        process["state"] = json!("running");
        assert_eq!(
            validate_native_work_shell_change(&starting, &running),
            Ok(())
        );
        let refs = json!([
            "tool-result://call",
            format!("local-shell-artifact://{handle}/stdout"),
            format!("local-shell-artifact://{handle}/stderr"),
            format!("local-shell-artifact://{handle}/metadata")
        ]);
        let mut published = running.clone();
        let startup = json!({"evidenceId":"evidence","evidenceRefs":refs});
        attempt(&mut published)["pendingTools"][0]["nativeBackgroundShell"]["startup"] =
            startup.clone();
        assert_eq!(
            validate_native_work_shell_change(&running, &published),
            Ok(())
        );
        assert_eq!(
            validate_native_work_shell_change(&starting, &published),
            Err(INVALID)
        );
        let mut forged = published.clone();
        attempt(&mut forged)["pendingTools"][0]["nativeBackgroundShell"]["startup"]["evidenceId"] =
            json!("forged");
        assert_eq!(
            validate_native_work_shell_change(&published, &forged),
            Err(INVALID)
        );
        let mut ended = published.clone();
        let process = &mut attempt(&mut ended)["pendingTools"][0]["nativeProcess"];
        process["state"] = json!("ended");
        process["stopObservation"] = json!("owned_completion");
        assert_eq!(
            validate_native_work_shell_change(&published, &ended),
            Ok(())
        );
        let mut settled = ended.clone();
        let settled_attempt = attempt(&mut settled);
        settled_attempt["pendingTools"] = json!([]);
        settled_attempt["settledTools"] = json!([
            {"dispatchId":"dispatch","toolCallId":"call","outcome":"resulted","evidenceRefs":refs}
        ]);
        assert_eq!(
            validate_native_work_shell_change(&published, &settled),
            Err(INVALID)
        );
        assert_eq!(validate_native_work_shell_change(&ended, &settled), Ok(()));
        attempt(&mut settled)["settledTools"][0]["evidenceRefs"] = json!([]);
        assert_eq!(
            validate_native_work_shell_change(&ended, &settled),
            Err(INVALID)
        );
    }
}
