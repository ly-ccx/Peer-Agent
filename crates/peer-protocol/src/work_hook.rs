//! Canonical Hooks for the original Work dispatch. Shape validation binds each
//! observation to its recorded process. It cannot confirm an effect or a stop.
use crate::{
    NativeOwnedProcess, NativeProcessRecorder, NativeProcessStop,
    conversation_hook::valid_conversation_hook_observation, normalize_native_episode_recorder,
    normalize_session_execution_identity,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

pub const WORK_HOOK_SEMANTIC_FLOOR: u64 = 14;
const MAX_HANDLES: usize = 256;
const INVALID: &str = "native_work_hooks_invalid";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkProviderPhase {
    Prepared,
    Dispatching,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkHook {
    pub event: String,
    pub rule_digest: String,
    pub process: NativeOwnedProcess,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observation: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkHookIntent {
    pub message_id: String,
    pub args_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeWorkHooks {
    pub schema_version: u8,
    pub provider_phase: WorkProviderPhase,
    pub handles: Vec<NativeWorkHook>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intent: Option<WorkHookIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant: Option<Value>,
}

impl NativeWorkHooks {
    pub fn read(row: &Value) -> Result<Option<Self>, &'static str> {
        let Some(raw) = row.get("nativeHooks") else {
            return Ok(None);
        };
        if raw["handles"]
            .as_array()
            .is_none_or(|handles| handles.len() > MAX_HANDLES)
        {
            return Err(INVALID);
        }
        let hooks: Self = serde_json::from_value(raw.clone()).map_err(|_| INVALID)?;
        let recorder = &row["nativeRecorder"];
        let execution =
            normalize_session_execution_identity(&recorder["execution"]).ok_or(INVALID)?;
        let owner: NativeProcessRecorder =
            serde_json::from_value(recorder["recorder"].clone()).map_err(|_| INVALID)?;
        if raw.get("intent").is_some()
            && hooks.intent.as_ref().is_none_or(|intent| {
                intent.message_id.is_empty()
                    || intent.message_id.len() > 200
                    || intent.message_id.chars().any(char::is_control)
                    || !valid_digest(&intent.args_digest)
            })
            || hooks.schema_version != 1
            || normalize_native_episode_recorder(recorder, &execution).is_none()
            || !row["toolCallId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 200)
            || !row["dispatchId"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 200)
            || hooks.provider_phase == WorkProviderPhase::Prepared
                && row.get("nativeProcess").is_some()
        {
            return Err(INVALID);
        }
        if raw.get("grant").is_some()
            && hooks.grant.as_ref().is_none_or(|grant| {
                hooks.provider_phase != WorkProviderPhase::Dispatching
                    || hooks.intent.is_none()
                    || grant["granted"] != true
                    || grant["toolCallId"] != row["toolCallId"]
                    || grant["duration"] != "once"
                    || !grant["grantId"].as_str().is_some_and(|s| !s.is_empty())
            })
        {
            return Err(INVALID);
        }
        let mut ids = HashSet::new();
        for (hook, raw_hook) in hooks.handles.iter().zip(raw["handles"].as_array().unwrap()) {
            let p = &hook.process;
            if !matches!(hook.event.as_str(), "PreToolUse" | "PostToolUse")
                || hooks.provider_phase == WorkProviderPhase::Prepared
                    && hook.event == "PostToolUse"
                || !valid_digest(&hook.rule_digest)
                || !p.valid()
                || p.owner != owner
                || normalize_session_execution_identity(&p.execution).as_ref() != Some(&execution)
                || p.tool_call_id != row["toolCallId"]
                || p.dispatch_id != row["dispatchId"]
                || p.generation > 1
                || !ids.insert(&p.handle_id)
                || p.handle_id == row["nativeProcess"]["handleId"]
            {
                return Err(INVALID);
            }
            let observation_valid = match p.stop_observation {
                Some(NativeProcessStop::OwnedCompletion) => {
                    hook.observation.as_ref().is_some_and(|v| {
                        valid_conversation_hook_observation(
                            v,
                            &raw_hook["event"],
                            &hook.rule_digest,
                            &p.handle_id,
                        )
                    })
                }
                _ => raw_hook.get("observation").is_none(),
            };
            if !observation_valid {
                return Err(INVALID);
            }
        }
        Ok(Some(hooks))
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn native_work_has_hook_facts(work: &Value) -> Result<bool, &'static str> {
    let budget = &work["budget"];
    let rows = budget["attempts"]
        .as_object()
        .into_iter()
        .flat_map(|attempts| attempts.values())
        .flat_map(|attempt| attempt["pendingTools"].as_array().into_iter().flatten())
        .chain(
            budget["uncertainDispatches"]
                .as_array()
                .into_iter()
                .flatten(),
        );
    let mut any = false;
    let mut ids = HashSet::new();
    for row in rows {
        if let Some(hooks) = NativeWorkHooks::read(row)? {
            any = true;
            for hook in hooks.handles {
                if ids.len() >= MAX_HANDLES || !ids.insert(hook.process.handle_id) {
                    return Err(INVALID);
                }
            }
        }
    }
    Ok(any)
}
