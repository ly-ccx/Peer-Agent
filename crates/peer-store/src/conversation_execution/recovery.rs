//! Exclusive recovery scope over the existing directory, not a new execution
//! owner or a dispatch token. The Runtime must supply actual OS observations.
use super::*;
use peer_protocol::{NativeProcessState, NativeProcessStop};
use rustix::fs::{FlockOperation, Mode, OFlags};
use std::fs::File;

pub struct ConversationRecovery {
    directory: File,
    pub(super) token: ConversationExecutionToken,
}
impl ConversationStore {
    /// Read-only acquisition. The FD is CLOEXEC and its flock is released by
    /// the OS on process death. Existing mkdir locks are never expired/deleted.
    pub fn try_conversation_recovery(&self, id: &str) -> Result<ConversationRecovery, StoreError> {
        self.read_conversation_execution(id)?
            .ok_or(StoreError::NotFound)?;
        let path = std::fs::canonicalize(&self.directory).map_err(|_| StoreError::ReadFailed)?;
        if !std::fs::symlink_metadata(&self.directory)
            .map_err(|_| StoreError::ReadFailed)?
            .is_dir()
        {
            return Err(StoreError::ReadFailed);
        }
        let directory = rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(|_| StoreError::ReadFailed)?;
        rustix::fs::flock(&directory, FlockOperation::NonBlockingLockExclusive).map_err(|e| {
            if matches!(e, rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) {
                StoreError::LockBusy
            } else {
                StoreError::ReadFailed
            }
        })?;
        let run = self
            .read_conversation_execution(id)?
            .ok_or(StoreError::ExecutionChanged)?;
        let location = directory_identity(&directory).map_err(|_| StoreError::ReadFailed)?;
        let recovery = ConversationRecovery {
            directory,
            token: ConversationExecutionToken {
                directory: path,
                identity: run.identity.clone(),
                owner: run.owner.clone(),
                revision: run.revision,
                recovery_control: Some(run),
                recovery_directory: Some(location),
            },
        };
        recovery.current(self)?;
        Ok(recovery)
    }
}
impl ConversationRecovery {
    /// Host observation after original-owner death. Only a canonical prepared
    /// intent can receive this cancelled/not_dispatched fact. It cannot grant
    /// execution or turn an unknown dispatched outcome into a known result.
    pub fn cancel_prepared(
        &mut self,
        store: &ConversationStore,
        call: &str,
        at: &str,
    ) -> Result<(), StoreError> {
        let run = self.current(store)?;
        let pending = run
            .pending_tools
            .iter()
            .find(|p| p.tool_call_id == call)
            .ok_or(StoreError::ExecutionChanged)?;
        if run.phase == Phase::Active
            || pending.phase != DispatchPhase::Prepared
            || pending.native_process.is_some()
            || run.handles.iter().any(|h| h["toolCallId"] == call)
        {
            return Err(StoreError::ExecutionChanged);
        }
        let snapshot = store.read_committed(&run.identity.conversation_id, None, log::MAX_BYTES)?;
        let row = snapshot
            .history
            .messages
            .iter()
            .find(|m| {
                m["id"] == pending.message_id
                    && m["streamId"] == run.identity.stream_id
                    && m["role"] == "assistant"
            })
            .ok_or(StoreError::ExecutionChanged)?;
        let mut segments = row["segments"]
            .as_array()
            .ok_or(StoreError::ExecutionInvalid)?
            .clone();
        let matches: Vec<_> = segments
            .iter()
            .enumerate()
            .filter(|(_, s)| s["type"] == "tool-call" && s["toolCallId"] == call)
            .map(|(i, _)| i)
            .collect();
        if matches.len() != 1 {
            return Err(StoreError::ExecutionInvalid);
        }
        let segment = &mut segments[matches[0]];
        if peer_protocol::approval_args_digest(&segment["args"])
            .ok()
            .as_deref()
            != Some(pending.args_digest.as_str())
        {
            return Err(StoreError::ExecutionChanged);
        }
        if segment.get("result").is_some() {
            return Ok(());
        }
        let mut grants = row["permissionGrants"]
            .as_array()
            .ok_or(StoreError::ExecutionInvalid)?
            .clone();
        let actual: Vec<_> = grants.iter().filter(|g| g["toolCallId"] == call).collect();
        if actual.len() > 1 || actual.first().is_some_and(|g| !g["granted"].is_boolean()) {
            return Err(StoreError::ExecutionInvalid);
        }
        if actual.is_empty() {
            grants.push(serde_json::json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":call,"granted":false,"duration":"denied","decidedAt":at,"reason":"permission_cancelled"}));
        }
        segment["result"] = serde_json::json!({"toolCallId":call,"capabilityId":pending.capability_id,"status":"cancelled","output":{},"outputPreview":{"kind":"json"},"completedAt":at,"error":{"code":"CANCELLED","message":"Original owner ended before dispatch","recoverable":true},"evidence":{"evidenceId":format!("evidence-{}",uuid::Uuid::new_v4()),"toolCallId":call,"summary":"Original owner ended before dispatch","artifactRefs":[],"dispatchOutcome":"not_dispatched"}});
        self.current(store)?;
        store.commit_terminal_message(
            &snapshot,
            &pending.message_id,
            &serde_json::json!({"segments":segments,"permissionGrants":grants}),
            at,
            None,
        )?;
        self.current(store)?;
        Ok(())
    }
    fn check_directory(&self, store: &ConversationStore) -> Result<(), StoreError> {
        let path =
            std::fs::canonicalize(&store.directory).map_err(|_| StoreError::ExecutionChanged)?;
        if path != self.token.directory {
            return Err(StoreError::ExecutionChanged);
        }
        let named = rustix::fs::open(
            &path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|_| StoreError::ExecutionChanged)?;
        let held = rustix::fs::fstat(&self.directory).map_err(|_| StoreError::ReadFailed)?;
        let named = rustix::fs::fstat(named).map_err(|_| StoreError::ExecutionChanged)?;
        if (held.st_dev, held.st_ino) != (named.st_dev, named.st_ino) {
            return Err(StoreError::ExecutionChanged);
        }
        Ok(())
    }
    pub fn current(&self, store: &ConversationStore) -> Result<ConversationExecution, StoreError> {
        self.check_directory(store)?;
        let run = store
            .read_conversation_execution(&self.token.identity.conversation_id)?
            .ok_or(StoreError::ExecutionChanged)?;
        if self.token.recovery_control.as_ref() != Some(&run) {
            return Err(StoreError::ExecutionChanged);
        }
        Ok(run)
    }
    pub fn identity(&self) -> &ConversationExecutionIdentity {
        &self.token.identity
    }
    pub fn owner(&self) -> &NativeProcessRecorder {
        &self.token.owner
    }
    /// Only after actual owner death or a previously canonical local stop. This
    /// freezes cognition; dispatch intent becomes unknown, never replayable.
    pub fn close_admission(
        &mut self,
        store: &ConversationStore,
        at: &str,
    ) -> Result<(), StoreError> {
        let run = self.current(store)?;
        if run.stop.is_some()
            || run.phase == Phase::Stopping
                && run
                    .pending_tools
                    .iter()
                    .all(|p| p.phase != DispatchPhase::Dispatching)
        {
            return Ok(());
        }
        store.mutate_execution(&mut self.token, at, None, |run, _| {
            run.phase = Phase::Stopping;
            for pending in &mut run.pending_tools {
                if pending.phase == DispatchPhase::Dispatching {
                    pending.phase = DispatchPhase::OutcomeUnknown;
                }
            }
            Ok(())
        })?;
        Ok(())
    }
    pub fn process_ended(
        &mut self,
        store: &ConversationStore,
        before: &NativeOwnedProcess,
        observation: NativeProcessStop,
        at: &str,
    ) -> Result<(), StoreError> {
        self.current(store)?;
        if !matches!(
            (before.state, observation),
            (
                NativeProcessState::NotStarted,
                NativeProcessStop::OwnerDeadNotStarted
            ) | (
                NativeProcessState::Running,
                NativeProcessStop::OwnerDeadGroupAbsent
            )
        ) {
            return Err(StoreError::ExecutionInvalid);
        }
        store.mutate_execution(&mut self.token, at, None, |run, _| {
            let process = run
                .pending_tools
                .iter_mut()
                .find(|p| p.tool_call_id == before.tool_call_id)
                .and_then(|p| p.native_process.as_mut())
                .ok_or(StoreError::ExecutionChanged)?;
            if process != before {
                return Err(StoreError::ExecutionChanged);
            }
            process.state = NativeProcessState::Ended;
            process.stop_observation = Some(observation);
            Ok(())
        })?;
        Ok(())
    }
    pub fn handle_ended(
        &mut self,
        store: &ConversationStore,
        before: &Value,
        at: &str,
    ) -> Result<(), StoreError> {
        let run = self.current(store)?;
        if !run.handles.contains(before) {
            return Err(StoreError::ExecutionChanged);
        }
        store.end_conversation_handle(
            &mut self.token,
            before["handleId"]
                .as_str()
                .ok_or(StoreError::ExecutionInvalid)?,
            at,
        )?;
        Ok(())
    }
    /// Uses the very same canonical Grant/Result/Evidence settlement gate.
    pub fn settle_tool(
        &mut self,
        store: &ConversationStore,
        call: &str,
        message: &str,
        at: &str,
    ) -> Result<(), StoreError> {
        self.current(store)?;
        store.settle_conversation_tool(&mut self.token, call, message, at)?;
        Ok(())
    }
    pub fn finish_stop(&mut self, store: &ConversationStore, at: &str) -> Result<(), StoreError> {
        let run = self.current(store)?;
        if run.stop.is_some() {
            return Ok(());
        }
        store.finish_conversation_execution(
            &mut self.token,
            &ConversationStopObservation {
                owner: run.owner,
                observed_at: at.into(),
                runner_idle: true,
                admission_closed: true,
                handles_ended: true,
            },
            at,
        )?;
        Ok(())
    }
    /// Original per-stream aggregate and sealed actual receipt; no new model
    /// observations or an independent recovery billing identity are possible.
    pub fn commit_usage(
        &mut self,
        store: &ConversationStore,
        at: &str,
    ) -> Result<Option<Value>, StoreError> {
        let run = self.current(store)?;
        if run.usage_committed {
            return Ok(None);
        }
        let receipt = store.commit_conversation_usage(&self.token)?;
        let lifetime = receipt.receipt().map(|r| r["lifetimeUsage"].clone());
        store.acknowledge_conversation_usage(&mut self.token, receipt, at)?;
        Ok(lifetime)
    }
}
