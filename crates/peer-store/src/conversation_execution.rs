//! Single ordinary-run owner in the original Conversation index. The index
//! records execution facts; permissions and results remain their original Stores.
use crate::{
    ConversationStore, HistorySnapshot, StoreError,
    conversation_write::{locks, position, timestamp},
    durable_jsonl as log, files,
};
use peer_protocol::{
    ConversationDispatchPhase as DispatchPhase, ConversationExecution,
    ConversationExecutionIdentity, ConversationExecutionPhase as Phase, ConversationPendingTool,
    ConversationStopObservation, NativeOwnedProcess, NativeProcessRecorder, RuntimeTurnUsage,
    normalize_conversation_execution,
};
use serde_json::Value;
use std::{path::PathBuf, sync::atomic::AtomicBool};

/// Host intent, not a deserializable command or a reusable permission.
pub struct NewConversationExecution<'a> {
    pub stream_id: &'a str,
    pub engine: &'a str,
    pub owner: &'a NativeProcessRecorder,
    pub attribution: &'a Value,
    pub at: &'a str,
}
/// An owned run can be reopened after a Store-only uncertain publication. No
/// public fields, Clone or Deserialize permit another run to mint this token.
pub struct ConversationExecutionToken {
    directory: PathBuf,
    identity: ConversationExecutionIdentity,
    owner: NativeProcessRecorder,
    revision: u64,
}
impl ConversationExecutionToken {
    pub fn identity(&self) -> &ConversationExecutionIdentity {
        &self.identity
    }
    pub fn owner(&self) -> &NativeProcessRecorder {
        &self.owner
    }
}
/// Created only after an actual metadata-only write. A Host may return this
/// receipt to cognition; a JSON object or provider result cannot manufacture it.
pub struct ConversationMetadataPublication {
    conversation: String,
    content_revision: u64,
    before: String,
    after: String,
}
impl ConversationMetadataPublication {
    pub fn advance(
        &self,
        conversation: &str,
        revision: u64,
        source: &str,
    ) -> Result<&str, StoreError> {
        if conversation != self.conversation
            || revision != self.content_revision
            || source != self.before
        {
            return Err(StoreError::ContextConflict);
        }
        Ok(&self.after)
    }
    pub fn chain(self, next: Self) -> Result<Self, StoreError> {
        if self.conversation != next.conversation
            || self.content_revision != next.content_revision
            || self.after != next.before
        {
            return Err(StoreError::ContextConflict);
        }
        Ok(Self {
            after: next.after,
            ..self
        })
    }
}
pub struct ConversationUsageReceipt {
    directory: PathBuf,
    owner: NativeProcessRecorder,
    identity: ConversationExecutionIdentity,
    usage: Option<RuntimeTurnUsage>,
    attribution: Value,
    receipt: Option<Value>,
}
impl ConversationUsageReceipt {
    pub fn receipt(&self) -> Option<&Value> {
        self.receipt.as_ref()
    }
}
fn decode(meta: &Value, conversation: &str) -> Result<Option<ConversationExecution>, StoreError> {
    let Some(value) = meta.get("runtimeExecution") else {
        return Ok(None);
    };
    let run = normalize_conversation_execution(value).map_err(|_| StoreError::ExecutionInvalid)?;
    if run.identity.conversation_id != conversation {
        return Err(StoreError::ExecutionInvalid);
    }
    Ok(Some(run))
}
impl ConversationStore {
    pub fn read_conversation_execution(
        &self,
        id: &str,
    ) -> Result<Option<ConversationExecution>, StoreError> {
        let meta = self
            .read_metadata(id)?
            .metadata
            .ok_or(StoreError::NotFound)?;
        decode(&meta, id)
    }
    pub fn claim_conversation_execution(
        &self,
        expected: &HistorySnapshot,
        intent: &NewConversationExecution<'_>,
        cancel: Option<&AtomicBool>,
    ) -> Result<(ConversationExecutionToken, ConversationMetadataPublication), StoreError> {
        let id = &expected.history.conversation_id;
        let directory = self.write_directory()?;
        let _held = locks(&directory, Some(id), cancel)?;
        let current = self.read_committed(id, None, log::MAX_BYTES)?;
        if current.source_revision != expected.source_revision
            || current.history.content_revision != expected.history.content_revision
        {
            return Err(StoreError::VersionChanged);
        }
        if current.history.excluded_from_message_id.is_some() {
            return Err(StoreError::StreamStateInvalid);
        }
        let mut index = log::read(&directory.join("index.jsonl"), cancel)?;
        let pos = position(&index, id)?;
        if index[pos]
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || index[pos]
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            return Err(StoreError::OutOfScope);
        }
        if decode(&index[pos], id)?
            .is_some_and(|run| !run.permits_new_run() || run.identity.stream_id == intent.stream_id)
        {
            return Err(StoreError::ExecutionBusy);
        }
        if !timestamp(intent.at) {
            return Err(StoreError::InvalidInput);
        }
        let run = ConversationExecution {
            schema_version: 1,
            identity: ConversationExecutionIdentity {
                conversation_id: id.clone(),
                stream_id: intent.stream_id.into(),
            },
            engine: intent.engine.into(),
            owner: intent.owner.clone(),
            revision: 1,
            phase: Phase::Active,
            pending_tools: vec![],
            handles: vec![],
            usage: None,
            unknown_usage: false,
            attribution: intent.attribution.clone(),
            usage_committed: true,
            stop: None,
            updated_at: intent.at.into(),
        };
        let raw = serde_json::to_value(&run).map_err(|_| StoreError::ExecutionInvalid)?;
        normalize_conversation_execution(&raw).map_err(|_| StoreError::ExecutionInvalid)?;
        index[pos]["runtimeExecution"] = raw;
        let receipt = self.publish_execution_metadata(&directory, &current, &index, cancel)?;
        let token = ConversationExecutionToken {
            directory,
            identity: run.identity,
            owner: run.owner,
            revision: 1,
        };
        Ok((token, receipt))
    }
    fn publish_execution_metadata(
        &self,
        directory: &std::path::Path,
        current: &HistorySnapshot,
        index: &[Value],
        cancel: Option<&AtomicBool>,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        let id = &current.history.conversation_id;
        let before = [
            files::identity(&directory.join(format!("{id}.jsonl")))?,
            files::identity(&directory.join(format!("{id}.stream.json")))?,
        ];
        // Match the entire current source before publishing; locks alone do not
        // attest an external writer that ignores the shared protocol.
        if self
            .read_committed(id, None, log::MAX_BYTES)?
            .source_revision
            != current.source_revision
        {
            return Err(StoreError::VersionChanged);
        }
        log::replace(&directory.join("index.jsonl"), &log::encode(index)?, cancel)?;
        let finish = (|| {
            #[cfg(feature = "test-fixtures")]
            if directory
                .parent()
                .is_some_and(|p| p.join(".native-cli-fixture").is_file())
                && std::env::var("PEER_CONVERSATION_EXECUTION_FAULT").as_deref()
                    == Ok("after_index")
            {
                std::process::exit(87)
            }
            let fresh = self.read_committed(id, None, log::MAX_BYTES)?;
            if fresh.history != current.history
                || log::read(&directory.join("index.jsonl"), None)? != index
                || before
                    != [
                        files::identity(&directory.join(format!("{id}.jsonl")))?,
                        files::identity(&directory.join(format!("{id}.stream.json")))?,
                    ]
            {
                return Err(StoreError::VersionChanged);
            }
            if self
                .read_committed(id, None, log::MAX_BYTES)?
                .source_revision
                != fresh.source_revision
            {
                return Err(StoreError::VersionChanged);
            }
            Ok(ConversationMetadataPublication {
                conversation: id.clone(),
                content_revision: current.history.content_revision,
                before: current.source_revision.clone(),
                after: fresh.source_revision,
            })
        })();
        finish.map_err(|_| StoreError::CommitUncertain)
    }
    fn mutate_execution(
        &self,
        token: &mut ConversationExecutionToken,
        at: &str,
        cancel: Option<&AtomicBool>,
        change: impl FnOnce(&mut ConversationExecution, &HistorySnapshot) -> Result<(), StoreError>,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        if !timestamp(at) || self.write_directory()? != token.directory {
            return Err(StoreError::ExecutionChanged);
        }
        let id = &token.identity.conversation_id;
        let directory = &token.directory;
        let _held = locks(directory, Some(id), cancel)?;
        let current = self.read_committed(id, None, log::MAX_BYTES)?;
        let mut index = log::read(&directory.join("index.jsonl"), cancel)?;
        let pos = position(&index, id)?;
        let mut run = decode(&index[pos], id)?.ok_or(StoreError::ExecutionChanged)?;
        if run.identity != token.identity
            || run.owner != token.owner
            || run.revision != token.revision
        {
            return Err(StoreError::ExecutionChanged);
        }
        change(&mut run, &current)?;
        run.revision = run
            .revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(StoreError::ExecutionInvalid)?;
        run.updated_at = at.into();
        let raw = serde_json::to_value(&run).map_err(|_| StoreError::ExecutionInvalid)?;
        normalize_conversation_execution(&raw).map_err(|_| StoreError::ExecutionInvalid)?;
        index[pos]["runtimeExecution"] = raw;
        let receipt = self.publish_execution_metadata(directory, &current, &index, cancel)?;
        token.revision = run.revision;
        Ok(receipt)
    }
    /// Re-read only the same owned run after indeterminate Store publication.
    /// This cannot transfer ownership, confirm an effect, or bypass run phase.
    pub fn refresh_conversation_execution(
        &self,
        token: &mut ConversationExecutionToken,
    ) -> Result<ConversationExecution, StoreError> {
        if self.write_directory()? != token.directory {
            return Err(StoreError::ExecutionChanged);
        }
        let run = self
            .read_conversation_execution(&token.identity.conversation_id)?
            .ok_or(StoreError::ExecutionChanged)?;
        if run.identity != token.identity
            || run.owner != token.owner
            || run.revision < token.revision
        {
            return Err(StoreError::ExecutionChanged);
        }
        token.revision = run.revision;
        Ok(run)
    }
    pub fn observe_conversation_usage(
        &self,
        token: &mut ConversationExecutionToken,
        usage: &RuntimeTurnUsage,
        unknown: bool,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if run.phase != Phase::Active {
                return Err(StoreError::ExecutionChanged);
            }
            if let Some(old) = &run.usage
                && (usage.provider_request_count < old.provider_request_count
                    || usage.amounts.input_tokens < old.amounts.input_tokens
                    || usage.amounts.output_tokens < old.amounts.output_tokens
                    || usage.amounts.cache_read_tokens < old.amounts.cache_read_tokens
                    || usage.amounts.cache_write_tokens < old.amounts.cache_write_tokens)
            {
                return Err(StoreError::UsageConflict);
            }
            run.usage = Some(usage.clone());
            run.unknown_usage |= unknown;
            run.usage_committed = usage.amounts.total_tokens == 0;
            Ok(())
        })
    }
    pub fn prepare_conversation_tool(
        &self,
        token: &mut ConversationExecutionToken,
        call: &ConversationPendingTool,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, cancel, |run, _| {
            if run.phase != Phase::Active
                || call.phase != DispatchPhase::Prepared
                || call.native_process.is_some()
                || !run.pending_tools.is_empty()
            {
                return Err(StoreError::ExecutionBusy);
            }
            run.pending_tools.push(call.clone());
            Ok(())
        })
    }
    pub fn dispatch_conversation_tool(
        &self,
        token: &mut ConversationExecutionToken,
        call_id: &str,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, cancel, |run, _| {
            if run.phase != Phase::Active {
                return Err(StoreError::ExecutionChanged);
            }
            let call = run
                .pending_tools
                .iter_mut()
                .find(|p| p.tool_call_id == call_id)
                .ok_or(StoreError::ExecutionChanged)?;
            if call.phase != DispatchPhase::Prepared {
                return Err(StoreError::ExecutionChanged);
            }
            call.phase = DispatchPhase::Dispatching;
            Ok(())
        })
    }
    pub fn record_conversation_process(
        &self,
        token: &mut ConversationExecutionToken,
        process: &NativeOwnedProcess,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            let call = run
                .pending_tools
                .iter_mut()
                .find(|p| {
                    p.tool_call_id == process.tool_call_id && p.dispatch_id == process.dispatch_id
                })
                .ok_or(StoreError::ExecutionChanged)?;
            if call.phase != DispatchPhase::Dispatching {
                return Err(StoreError::ExecutionChanged);
            }
            if let Some(old) = &call.native_process {
                if old.handle_id != process.handle_id
                    || old.generation > process.generation
                    || old.owner != process.owner
                    || old.execution != process.execution
                {
                    return Err(StoreError::ExecutionChanged);
                }
                use peer_protocol::NativeProcessState as State;
                let same_generation = old.generation == process.generation
                    && (old == process
                        || matches!(
                            (old.state, process.state),
                            (State::NotStarted, State::Ended)
                                | (State::Starting, State::Running | State::Ended)
                                | (State::Running, State::Ended)
                        ));
                let next_generation = old.generation.checked_add(1) == Some(process.generation)
                    && run.phase == Phase::Active
                    && matches!(old.state, State::NotStarted | State::Ended)
                    && process.state == State::Starting;
                if !same_generation && !next_generation {
                    return Err(StoreError::ExecutionChanged);
                }
                if old.child.is_some() && same_generation && process.child != old.child {
                    return Err(StoreError::ExecutionChanged);
                }
            } else if run.phase != Phase::Active
                || process.state != peer_protocol::NativeProcessState::NotStarted
                || process.generation != 0
            {
                return Err(StoreError::ExecutionChanged);
            }
            call.native_process = Some(process.clone());
            Ok(())
        })
    }
    pub fn register_conversation_handle(
        &self,
        token: &mut ConversationExecutionToken,
        handle: &Value,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if run.phase != Phase::Active
                || !run.pending_tools.iter().any(|p| {
                    p.tool_call_id == handle["toolCallId"] && p.phase == DispatchPhase::Dispatching
                })
                || run
                    .handles
                    .iter()
                    .any(|h| h["handleId"] == handle["handleId"])
            {
                return Err(StoreError::ExecutionChanged);
            }
            run.handles.push(handle.clone());
            Ok(())
        })
    }
    pub fn end_conversation_handle(
        &self,
        token: &mut ConversationExecutionToken,
        handle: &str,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            let i = run
                .handles
                .iter()
                .position(|h| h["handleId"] == handle)
                .ok_or(StoreError::ExecutionChanged)?;
            // Runtime calls this only after the actual owned driver has ended.
            run.handles.remove(i);
            Ok(())
        })
    }
    /// Called by the actual owned MCP transport after observing its child tuple.
    /// A late cancellation does not discard the child needed for accountability.
    pub fn record_conversation_handle_child(
        &self,
        token: &mut ConversationExecutionToken,
        handle: &str,
        child: &NativeProcessRecorder,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if !child.complete()
                || child.boot_id != run.owner.boot_id
                || child.host_id != run.owner.host_id
                || child.acquired_at != run.owner.acquired_at
            {
                return Err(StoreError::ExecutionInvalid);
            }
            let h = run
                .handles
                .iter_mut()
                .find(|h| h["handleId"] == handle)
                .ok_or(StoreError::ExecutionChanged)?;
            let n = &mut h["metadata"]["nativeMcp"];
            let raw = serde_json::to_value(child).map_err(|_| StoreError::ExecutionInvalid)?;
            if n["role"] != "connection"
                || n["transport"] != "stdio"
                || n["ownerRecorder"] != serde_json::to_value(&run.owner).unwrap()
                || n.get("childRecorder").is_some_and(|old| old != &raw)
            {
                return Err(StoreError::ExecutionInvalid);
            }
            n["childRecorder"] = raw;
            Ok(())
        })
    }
    pub fn settle_conversation_tool(
        &self,
        token: &mut ConversationExecutionToken,
        call_id: &str,
        message_id: &str,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        let home = token
            .directory
            .parent()
            .ok_or(StoreError::InvalidInput)?
            .to_owned();
        self.mutate_execution(token, at, None, |run, history| {
            let i = run
                .pending_tools
                .iter()
                .position(|p| p.tool_call_id == call_id)
                .ok_or(StoreError::ExecutionChanged)?;
            let pending = &run.pending_tools[i];
            let message = history
                .history
                .messages
                .iter()
                .find(|m| m["id"] == message_id)
                .ok_or(StoreError::ExecutionInvalid)?;
            let segment = message["segments"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["type"] == "tool-call" && s["toolCallId"] == call_id)
                .ok_or(StoreError::ExecutionInvalid)?;
            let result = &segment["result"];
            let grant = message["permissionGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|g| g["toolCallId"] == call_id)
                .ok_or(StoreError::ExecutionInvalid)?;
            if message_id != pending.message_id
                || message["streamId"] != run.identity.stream_id
                || result["toolCallId"] != call_id
                || result["capabilityId"] != pending.capability_id
                || !["success", "failed", "denied", "cancelled"]
                    .contains(&result["status"].as_str().unwrap_or(""))
                || result["error"]["code"] == "execution_outcome_unknown"
                || result["status"] == "success" && grant["granted"] != true
                || result["status"] == "success" && pending.phase == DispatchPhase::Prepared
                || grant["capabilityId"]
                    .as_str()
                    .is_some_and(|c| c != pending.capability_id)
                || run.handles.iter().any(|h| {
                    if h["toolCallId"] != call_id {
                        return false;
                    }
                    let n = &h["metadata"]["nativeMcp"];
                    !(pending.capability_id.starts_with("local.mcp.")
                        && h["metadata"]["kind"] == "mcp_connection"
                        && n["schemaVersion"] == 1
                        && n["role"] == "connection"
                        && n["ownerRecorder"] == serde_json::to_value(&run.owner).unwrap()
                        && n["registryRevision"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty())
                        && matches!(
                            n["transport"].as_str(),
                            Some("stdio" | "streamable_http" | "sse")
                        ))
                })
                || peer_protocol::approval_args_digest(&segment["args"])
                    .ok()
                    .as_deref()
                    != Some(pending.args_digest.as_str())
                || pending
                    .native_process
                    .as_ref()
                    .is_some_and(|p| p.state != peer_protocol::NativeProcessState::Ended)
            {
                return Err(StoreError::ExecutionInvalid);
            }
            let rows = crate::EvidenceIndexStore::new(&home)
                .find(&[format!("tool-result://{call_id}")], None)?;
            if !rows.iter().any(|r| {
                r["conversationId"] == run.identity.conversation_id
                    && r["streamId"] == run.identity.stream_id
                    && r["toolCallId"] == call_id
                    && r["capabilityId"] == pending.capability_id
            }) {
                return Err(StoreError::EvidenceInvalid);
            }
            run.pending_tools.remove(i);
            Ok(())
        })
    }
    pub fn stop_conversation_admission(
        &self,
        token: &mut ConversationExecutionToken,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if run.phase != Phase::Active {
                return Err(StoreError::ExecutionChanged);
            }
            run.phase = Phase::Stopping;
            Ok(())
        })
    }
    /// Host-only observation after actual local cleanup, never decoded from UI.
    pub fn finish_conversation_execution(
        &self,
        token: &mut ConversationExecutionToken,
        observation: &ConversationStopObservation,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if run.phase != Phase::Stopping
                || observation.owner != run.owner
                || !observation.runner_idle
                || !observation.admission_closed
                || !observation.handles_ended
                || !run.handles.is_empty()
                || run.pending_tools.iter().any(|p| {
                    p.native_process
                        .as_ref()
                        .is_some_and(|p| p.state != peer_protocol::NativeProcessState::Ended)
                })
            {
                return Err(StoreError::ExecutionBusy);
            }
            run.stop = Some(observation.clone());
            for call in &mut run.pending_tools {
                if call.phase == DispatchPhase::Dispatching {
                    call.phase = DispatchPhase::OutcomeUnknown
                }
            }
            run.phase = if run.pending_tools.is_empty() && run.usage_committed {
                Phase::Stopped
            } else {
                Phase::RecoveryRequired
            };
            Ok(())
        })
    }
    pub fn commit_conversation_usage(
        &self,
        token: &ConversationExecutionToken,
    ) -> Result<ConversationUsageReceipt, StoreError> {
        if self.write_directory()? != token.directory {
            return Err(StoreError::ExecutionChanged);
        }
        let run = self
            .read_conversation_execution(&token.identity.conversation_id)?
            .ok_or(StoreError::ExecutionChanged)?;
        if run.identity != token.identity
            || run.owner != token.owner
            || run.revision != token.revision
            || run.phase == Phase::Active
        {
            return Err(StoreError::ExecutionChanged);
        }
        let receipt = match run.usage.clone().filter(|u| u.amounts.total_tokens > 0) {
            Some(usage) => Some(
                self.record_runtime_turn_usage(
                    &run.identity.conversation_id,
                    &usage,
                    &run.attribution,
                    None,
                )?
                .ok_or(StoreError::UsageConflict)?,
            ),
            None => None,
        };
        Ok(ConversationUsageReceipt {
            directory: token.directory.clone(),
            owner: token.owner.clone(),
            identity: run.identity,
            usage: run.usage,
            attribution: run.attribution,
            receipt,
        })
    }
    pub fn acknowledge_conversation_usage(
        &self,
        token: &mut ConversationExecutionToken,
        receipt: ConversationUsageReceipt,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, _| {
            if self.write_directory()? != receipt.directory
                || run.owner != receipt.owner
                || run.identity != receipt.identity
                || run.usage != receipt.usage
                || run.attribution != receipt.attribution
                || run.phase == Phase::Active
            {
                return Err(StoreError::UsageConflict);
            }
            run.usage_committed = true;
            if run.stop.is_some() && run.pending_tools.is_empty() && run.handles.is_empty() {
                run.phase = Phase::Stopped
            }
            Ok(())
        })
    }
}
