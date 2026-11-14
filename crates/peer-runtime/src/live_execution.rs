//! Process-local ownership, bounded admission and a recoverable stop barrier.
//! Restart leaves ownership unknown; durable flags never recreate live tokens.
use peer_protocol::SessionExecutionIdentity;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveError {
    Limit,
    Closed,
    Conflict,
    Unknown,
    StopUnconfirmed,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    Live,
    Ended,
    Unknown,
}
#[derive(Clone, Default)]
pub struct ExecutionRegistry {
    inner: Arc<Inner>,
}
#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    changed: Notify,
}
#[derive(Default)]
struct State {
    next: u64,
    entries: BTreeMap<String, Entry>,
}
#[derive(Default)]
struct Entry {
    closed: bool,
    uncertain: bool,
    attempts: BTreeMap<u64, CancellationToken>,
    handles: BTreeMap<String, Handle>,
}
struct Handle {
    tool_call: String,
    cancel: CancellationToken,
    state: HandleState,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum HandleState {
    Active,
    Ended,
    Unknown,
}
pub struct Attempt {
    inner: Arc<Inner>,
    key: String,
    id: u64,
    cancellation: CancellationToken,
    finished: bool,
}
impl Attempt {
    pub fn cancellation(&self) -> CancellationToken {
        self.cancellation.clone()
    }
    /// Only the actual runner's normal finally path confirms completion. An
    /// abandoned/panicked task leaves uncertainty rather than fabricating idle.
    pub fn finish(mut self) {
        self.finished = true;
    }
}
impl Drop for Attempt {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(entry) = state.entries.get_mut(&self.key) {
                entry.attempts.remove(&self.id);
                entry.uncertain |= !self.finished;
            }
            self.inner.changed.notify_waiters();
        }
    }
}
fn key(execution: &SessionExecutionIdentity) -> Result<String, LiveError> {
    let value = serde_json::to_value(execution).map_err(|_| LiveError::Unknown)?;
    if peer_protocol::normalize_session_execution_identity(&value).as_ref() != Some(execution) {
        return Err(LiveError::Unknown);
    }
    peer_protocol::javascript_json_string(&value).map_err(|_| LiveError::Unknown)
}
fn ownership(entry: Option<&Entry>) -> Ownership {
    let Some(e) = entry else {
        return Ownership::Unknown;
    };
    if !e.attempts.is_empty() || e.handles.values().any(|h| h.state == HandleState::Active) {
        Ownership::Live
    } else if e.uncertain || e.handles.values().any(|h| h.state == HandleState::Unknown) {
        Ownership::Unknown
    } else {
        Ownership::Ended
    }
}
impl ExecutionRegistry {
    pub fn admission_open(&self, execution: &SessionExecutionIdentity) -> Result<bool, LiveError> {
        let key = key(execution)?;
        let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        Ok(state.entries.get(&key).is_some_and(|e| {
            !e.closed
                && !e.uncertain
                && !e.attempts.is_empty()
                && !e.handles.values().any(|h| h.state == HandleState::Unknown)
        }))
    }
    pub fn ownership(&self, execution: &SessionExecutionIdentity) -> Result<Ownership, LiveError> {
        let key = key(execution)?;
        let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        Ok(ownership(state.entries.get(&key)))
    }
    pub fn begin(&self, execution: &SessionExecutionIdentity) -> Result<Attempt, LiveError> {
        let key = key(execution)?;
        let mut state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        if !state.entries.contains_key(&key) && state.entries.len() >= 1024 {
            return Err(LiveError::Limit);
        }
        if state
            .entries
            .get(&key)
            .is_some_and(|e| e.closed || e.uncertain)
        {
            return Err(LiveError::Closed);
        }
        if state
            .entries
            .values()
            .map(|e| e.attempts.len())
            .sum::<usize>()
            >= 128
        {
            return Err(LiveError::Limit);
        }
        state.next = state.next.checked_add(1).ok_or(LiveError::Limit)?;
        let id = state.next;
        let cancellation = CancellationToken::new();
        state
            .entries
            .entry(key.clone())
            .or_default()
            .attempts
            .insert(id, cancellation.clone());
        Ok(Attempt {
            inner: self.inner.clone(),
            key,
            id,
            cancellation,
            finished: false,
        })
    }
    /// Called by the Provider owning the real completion future, after durable
    /// handle registration. Cancellation signals that same owner; it is not an
    /// ended observation. Failed completion remains unknown for reconciliation.
    pub fn track_handle(
        &self,
        execution: &SessionExecutionIdentity,
        handle_id: &str,
        tool_call: &str,
        cancellation: CancellationToken,
        completion: impl std::future::Future<Output = Result<(), ()>> + Send + 'static,
    ) -> Result<(), LiveError> {
        let key = key(execution)?;
        if [handle_id, tool_call]
            .into_iter()
            .any(|s| s.is_empty() || s.len() > 512)
        {
            return Err(LiveError::Limit);
        }
        let mut state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        if state
            .entries
            .values()
            .map(|e| e.handles.len())
            .sum::<usize>()
            >= 128
        {
            return Err(LiveError::Limit);
        }
        let entry = state.entries.get_mut(&key).ok_or(LiveError::Unknown)?;
        if entry.closed || entry.uncertain {
            return Err(LiveError::Closed);
        }
        if entry.handles.contains_key(handle_id) {
            return Err(LiveError::Conflict);
        }
        entry.handles.insert(
            handle_id.into(),
            Handle {
                tool_call: tool_call.into(),
                cancel: cancellation,
                state: HandleState::Active,
            },
        );
        let guard = HandleGuard {
            inner: self.inner.clone(),
            key,
            handle_id: handle_id.into(),
            ended: false,
        };
        tokio::spawn(async move {
            let mut guard = guard;
            guard.ended = completion.await.is_ok();
        });
        Ok(())
    }
    pub fn close_admission(&self, execution: &SessionExecutionIdentity) -> Result<(), LiveError> {
        let key = key(execution)?;
        let mut state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        if !state.entries.contains_key(&key) {
            if state.entries.len() >= 1024 {
                return Err(LiveError::Limit);
            }
            // Closing an execution we did not observe cannot establish idle.
            state.entries.insert(
                key.clone(),
                Entry {
                    uncertain: true,
                    ..Entry::default()
                },
            );
        }
        let entry = state.entries.get_mut(&key).ok_or(LiveError::Unknown)?;
        entry.closed = true;
        for token in entry.attempts.values() {
            token.cancel();
        }
        for handle in entry.handles.values() {
            if handle.state != HandleState::Ended {
                handle.cancel.cancel();
            }
        }
        self.inner.changed.notify_waiters();
        Ok(())
    }
    /// Deadline never aborts the completion owner. A later call can observe real
    /// idle; the admission fence and unknown handles survive the timeout.
    pub async fn drain(
        &self,
        execution: &SessionExecutionIdentity,
        deadline: Duration,
    ) -> Result<(), LiveError> {
        self.close_admission(execution)?;
        let wait = async {
            loop {
                let changed = self.inner.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                match self.ownership(execution)? {
                    Ownership::Ended => return Ok(()),
                    Ownership::Unknown => return Err(LiveError::Unknown),
                    Ownership::Live => changed.await,
                }
            }
        };
        tokio::time::timeout(deadline, wait)
            .await
            .map_err(|_| LiveError::StopUnconfirmed)?
    }
    pub fn handle_observations(
        &self,
        execution: &SessionExecutionIdentity,
    ) -> Result<Vec<(String, String, &'static str)>, LiveError> {
        let key = key(execution)?;
        let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        Ok(state
            .entries
            .get(&key)
            .map(|e| {
                e.handles
                    .iter()
                    .map(|(id, h)| {
                        (
                            id.clone(),
                            h.tool_call.clone(),
                            match h.state {
                                HandleState::Active => "active",
                                HandleState::Ended => "ended",
                                HandleState::Unknown => "unknown",
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default())
    }
    /// Called after the Host durably recorded the ended observation/result.
    /// Active and unknown handles cannot be evicted to manufacture idle.
    pub fn acknowledge_ended_handle(
        &self,
        execution: &SessionExecutionIdentity,
        handle_id: &str,
    ) -> Result<(), LiveError> {
        let key = key(execution)?;
        let mut state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        let entry = state.entries.get_mut(&key).ok_or(LiveError::Unknown)?;
        match entry.handles.get(handle_id) {
            Some(handle) if handle.state == HandleState::Ended => {
                entry.handles.remove(handle_id);
                Ok(())
            }
            None => Ok(()),
            _ => Err(LiveError::StopUnconfirmed),
        }
    }
}
struct HandleGuard {
    inner: Arc<Inner>,
    key: String,
    handle_id: String,
    ended: bool,
}
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(handle) = state
                .entries
                .get_mut(&self.key)
                .and_then(|e| e.handles.get_mut(&self.handle_id))
            {
                handle.state = if self.ended {
                    HandleState::Ended
                } else {
                    HandleState::Unknown
                };
            }
            self.inner.changed.notify_waiters();
        }
    }
}
