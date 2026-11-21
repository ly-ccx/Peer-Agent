//! Ordinary conversation execution facts in the existing Conversation index.
//! Decoding facts cannot grant, prove a stopped process, or replay a dispatch.
use crate::{
    NativeOwnedProcess, NativeProcessRecorder, RuntimeTurnUsage, normalize_execution_resource_scope,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
const SAFE: u64 = 9_007_199_254_740_991;
fn text(s: &str, max: usize) -> bool {
    !crate::javascript_trim(s).is_empty() && s.len() <= max && !s.chars().any(char::is_control)
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename = "conversation",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub struct ConversationExecutionIdentity {
    pub conversation_id: String,
    pub stream_id: String,
}
// Serde's struct `tag` is serialization-only. Decode through an internally
// tagged enum so the discriminator is required and unknown identity fields fail.
impl<'de> Deserialize<'de> for ConversationExecutionIdentity {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(tag = "kind", deny_unknown_fields)]
        enum Identity {
            #[serde(rename = "conversation", rename_all = "camelCase")]
            Conversation {
                conversation_id: String,
                stream_id: String,
            },
        }
        let Identity::Conversation {
            conversation_id,
            stream_id,
        } = Identity::deserialize(deserializer)?;
        Ok(Self {
            conversation_id,
            stream_id,
        })
    }
}
impl ConversationExecutionIdentity {
    pub fn valid(&self) -> bool {
        !self.conversation_id.is_empty()
            && self.conversation_id.len() <= 128
            && self
                .conversation_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && self.conversation_id.as_bytes()[0].is_ascii_alphanumeric()
            && text(&self.stream_id, 200)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationExecutionPhase {
    Active,
    Stopping,
    Stopped,
    RecoveryRequired,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationDispatchPhase {
    Prepared,
    Dispatching,
    OutcomeUnknown,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationPendingTool {
    pub tool_call_id: String,
    pub dispatch_id: String,
    pub message_id: String,
    pub capability_id: String,
    pub args_digest: String,
    pub phase: ConversationDispatchPhase,
    pub declared_scopes: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_process: Option<NativeOwnedProcess>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationStopObservation {
    pub owner: NativeProcessRecorder,
    pub observed_at: String,
    pub runner_idle: bool,
    pub admission_closed: bool,
    pub handles_ended: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationExecution {
    pub schema_version: u8,
    pub identity: ConversationExecutionIdentity,
    pub engine: String,
    pub owner: NativeProcessRecorder,
    pub revision: u64,
    pub phase: ConversationExecutionPhase,
    pub pending_tools: Vec<ConversationPendingTool>,
    pub handles: Vec<Value>,
    pub usage: Option<RuntimeTurnUsage>,
    pub unknown_usage: bool,
    pub attribution: Value,
    pub usage_committed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<ConversationStopObservation>,
    pub updated_at: String,
}
impl ConversationExecution {
    pub fn valid(&self) -> bool {
        if self.schema_version != 1
            || !self.identity.valid()
            || !self.owner.complete()
            || !matches!(self.engine.as_str(), "peer-native" | "peer-ts")
            || self.revision == 0
            || self.revision > SAFE
            || !text(&self.updated_at, 64)
            || self.pending_tools.len() > 128
            || self.handles.len() > 128
            || !self.attribution.is_object()
            || self.attribution["id"] != self.identity.stream_id
        {
            return false;
        }
        let allowed = [
            "id",
            "at",
            "streamId",
            "modelProviderId",
            "groupId",
            "model",
            "providerName",
            "role",
            "workspaceId",
            "estimatedCostUsd",
            "pricingSource",
        ];
        if self.attribution.as_object().unwrap().iter().any(|(k, v)| {
            !allowed.contains(&k.as_str())
                || !v.is_null()
                    && if k == "estimatedCostUsd" {
                        v.as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
                    } else {
                        v.as_str().is_none_or(|s| !text(s, 200))
                    }
        }) || self
            .attribution
            .get("streamId")
            .is_some_and(|v| v != &self.identity.stream_id)
        {
            return false;
        }
        if self
            .attribution
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
        {
            return false;
        }
        if let Some(usage) = &self.usage {
            let a = &usage.amounts;
            if usage.provider_request_count > SAFE
                || a.total_tokens > 0 && usage.provider_request_count == 0
                || [
                    a.input_tokens,
                    a.output_tokens,
                    a.cache_read_tokens,
                    a.cache_write_tokens,
                ]
                .into_iter()
                .try_fold(0u64, |n, v| n.checked_add(v).filter(|n| *n <= SAFE))
                    != Some(a.total_tokens)
            {
                return false;
            }
        }
        if let Some(stop) = &self.stop {
            if stop.owner != self.owner
                || !text(&stop.observed_at, 64)
                || !stop.runner_idle
                || !stop.admission_closed
                || !stop.handles_ended
                || matches!(
                    self.phase,
                    ConversationExecutionPhase::Active | ConversationExecutionPhase::Stopping
                )
            {
                return false;
            }
        } else if self.phase == ConversationExecutionPhase::Stopped {
            return false;
        }
        if self.phase == ConversationExecutionPhase::Stopped
            && (!self.pending_tools.is_empty() || !self.usage_committed)
        {
            return false;
        }
        let mut calls = HashSet::new();
        let mut dispatches = HashSet::new();
        let mut messages = HashSet::new();
        for p in &self.pending_tools {
            if [
                &p.tool_call_id,
                &p.dispatch_id,
                &p.message_id,
                &p.capability_id,
            ]
            .iter()
            .any(|s| !text(s, 200))
                || p.args_digest.len() != 64
                || !p
                    .args_digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !calls.insert(&p.tool_call_id)
                || !dispatches.insert(&p.dispatch_id)
                || !messages.insert(&p.message_id)
                || p.declared_scopes.len() > 32
                || p.declared_scopes
                    .iter()
                    .any(|s| normalize_execution_resource_scope(s).is_none())
            {
                return false;
            }
            if let Some(process) = &p.native_process
                && (p.phase == ConversationDispatchPhase::Prepared
                    || !process.valid_envelope()
                    || process.owner != self.owner
                    || process.tool_call_id != p.tool_call_id
                    || process.dispatch_id != p.dispatch_id
                    || process.execution != serde_json::to_value(&self.identity).unwrap())
            {
                return false;
            }
        }
        let mut handles = HashSet::new();
        let mut shell_sessions = 0;
        if self.handles.len() > 128 {
            return false;
        }
        for h in &self.handles {
            if h["metadata"]["kind"] == "shell_session" {
                shell_sessions += 1;
                if shell_sessions > 1
                    || crate::NativeShellSession::from_handle(h)
                        .is_none_or(|session| !session.valid_for_run(self))
                {
                    return false;
                }
            }
            if h.as_object().is_none_or(|m| m.len() != 4)
                || !h["handleId"]
                    .as_str()
                    .is_some_and(|s| text(s, 512) && handles.insert(s))
                || !h["toolCallId"].as_str().is_some_and(|s| text(s, 200))
                || !matches!(h["state"].as_str(), Some("active" | "ended"))
                || !h["metadata"].is_object()
                || h["metadata"]["kind"] == "hook"
                    && !crate::conversation_hook::valid_hook_handle(h, self)
                || h["metadata"]["kind"] == "shell_background"
                    && !crate::conversation_shell::valid_background_shell_handle(h, self)
                || self.phase == ConversationExecutionPhase::Stopped && h["state"] != "ended"
            {
                return false;
            }
        }
        true
    }
    pub fn permits_new_run(&self) -> bool {
        self.valid()
            && self.phase == ConversationExecutionPhase::Stopped
            && self.pending_tools.is_empty()
            && self.usage_committed
    }
}
pub(crate) fn recorder_shape(v: &Value) -> bool {
    v.as_object().is_some_and(|m| {
        m.len() == 5
            && m.keys().all(|k| {
                ["bootId", "pid", "pidStart", "hostId", "acquiredAt"].contains(&k.as_str())
            })
    })
}
pub fn normalize_conversation_execution(
    raw: &Value,
) -> Result<ConversationExecution, &'static str> {
    if raw["identity"]["kind"] != "conversation" || raw["schemaVersion"] != 1 {
        return Err("conversation_execution_invalid");
    }
    if raw.get("usage").is_none()
        || !recorder_shape(&raw["owner"])
        || raw
            .get("stop")
            .is_some_and(|s| !s.is_null() && !recorder_shape(&s["owner"]))
        || raw["usage"].as_object().is_some_and(|m| {
            raw["usage"]["usageScope"] != "runtime_turn"
                || m.len() != 7
                || m.keys().any(|k| {
                    ![
                        "usageScope",
                        "providerRequestCount",
                        "inputTokens",
                        "outputTokens",
                        "cacheReadTokens",
                        "cacheWriteTokens",
                        "totalTokens",
                    ]
                    .contains(&k.as_str())
                })
        })
        || raw["pendingTools"].as_array().is_some_and(|rows| {
            rows.iter().any(|row| {
                row.get("nativeProcess").is_some_and(|p| {
                    !p.is_null()
                        && (!recorder_shape(&p["owner"])
                            || p.get("child")
                                .is_some_and(|child| !child.is_null() && !recorder_shape(child)))
                })
            })
        })
    {
        return Err("conversation_execution_invalid");
    }
    let record: ConversationExecution =
        serde_json::from_value(raw.clone()).map_err(|_| "conversation_execution_invalid")?;
    record
        .valid()
        .then_some(record)
        .ok_or("conversation_execution_invalid")
}
