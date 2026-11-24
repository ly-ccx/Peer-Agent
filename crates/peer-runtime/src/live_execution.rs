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
    registration: u64,
    tool_call: String,
    cancel: CancellationToken,
    state: HandleState,
}
impl Handle {
    fn request_stop(&self) -> bool {
        if self.state == HandleState::Ended || self.cancel.is_cancelled() {
            return false;
        }
        self.cancel.cancel();
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandleStop {
    Stopped,
    AlreadyStoppingOrEnded,
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
mod sealed {
    pub trait Sealed {}
    impl Sealed for peer_protocol::SessionExecutionIdentity {}
    impl Sealed for peer_protocol::ConversationExecutionIdentity {}
}
/// Only the two canonical execution principals can own native live resources.
/// Validation identifies a principal; it cannot grant or prove local ownership.
pub trait LiveExecutionIdentity: sealed::Sealed {
    fn registry_key(&self) -> Result<String, LiveError>;
}
impl LiveExecutionIdentity for SessionExecutionIdentity {
    fn registry_key(&self) -> Result<String, LiveError> {
        let value = serde_json::to_value(self).map_err(|_| LiveError::Unknown)?;
        if peer_protocol::normalize_session_execution_identity(&value).as_ref() != Some(self) {
            return Err(LiveError::Unknown);
        }
        peer_protocol::javascript_json_string(&value).map_err(|_| LiveError::Unknown)
    }
}
impl LiveExecutionIdentity for peer_protocol::ConversationExecutionIdentity {
    fn registry_key(&self) -> Result<String, LiveError> {
        if !self.valid() {
            return Err(LiveError::Unknown);
        }
        let value = serde_json::to_value(self).map_err(|_| LiveError::Unknown)?;
        peer_protocol::javascript_json_string(&value).map_err(|_| LiveError::Unknown)
    }
}
fn key(execution: &impl LiveExecutionIdentity) -> Result<String, LiveError> {
    execution.registry_key()
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
    /// Called only by a Runtime Host after canonical stop/settlement acknowledgment.
    /// Missing entries remain unknown; active/uncertain resources cannot be evicted.
    pub(crate) fn forget_ended(
        &self,
        execution: &impl LiveExecutionIdentity,
    ) -> Result<(), LiveError> {
        let key = key(execution)?;
        let mut state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        let entry = state.entries.get(&key).ok_or(LiveError::Unknown)?;
        if !entry.closed || ownership(Some(entry)) != Ownership::Ended || !entry.handles.is_empty()
        {
            return Err(LiveError::StopUnconfirmed);
        }
        state.entries.remove(&key);
        Ok(())
    }
    pub fn admission_open(
        &self,
        execution: &impl LiveExecutionIdentity,
    ) -> Result<bool, LiveError> {
        let key = key(execution)?;
        let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        Ok(state.entries.get(&key).is_some_and(|e| {
            !e.closed
                && !e.uncertain
                && !e.attempts.is_empty()
                && !e.handles.values().any(|h| h.state == HandleState::Unknown)
        }))
    }
    pub fn ownership(
        &self,
        execution: &impl LiveExecutionIdentity,
    ) -> Result<Ownership, LiveError> {
        let key = key(execution)?;
        let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
        Ok(ownership(state.entries.get(&key)))
    }
    pub fn begin(&self, execution: &impl LiveExecutionIdentity) -> Result<Attempt, LiveError> {
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
        execution: &impl LiveExecutionIdentity,
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
        state.next = state.next.checked_add(1).ok_or(LiveError::Limit)?;
        let registration = state.next;
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
                registration,
                tool_call: tool_call.into(),
                cancel: cancellation,
                state: HandleState::Active,
            },
        );
        let guard = HandleGuard {
            inner: self.inner.clone(),
            key,
            handle_id: handle_id.into(),
            registration,
            ended: false,
        };
        tokio::spawn(async move {
            let mut guard = guard;
            guard.ended = completion.await.is_ok();
        });
        Ok(())
    }
    pub fn close_admission(&self, execution: &impl LiveExecutionIdentity) -> Result<(), LiveError> {
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
            handle.request_stop();
        }
        self.inner.changed.notify_waiters();
        Ok(())
    }
    /// Call only after current Host authorization for this exact handle. A
    /// stop request signals the original owner and awaits its real observation.
    /// The caller still owns Store publication and ended-handle acknowledgement.
    pub async fn stop_owned_handle(
        &self,
        execution: &impl LiveExecutionIdentity,
        handle_id: &str,
        original_tool_call: &str,
        deadline: Duration,
    ) -> Result<HandleStop, LiveError> {
        let key = key(execution)?;
        let mut requested = false;
        let mut registration = None;
        let wait = async {
            loop {
                let changed = self.inner.changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                {
                    let state = self.inner.state.lock().map_err(|_| LiveError::Unknown)?;
                    let handle = state
                        .entries
                        .get(&key)
                        .and_then(|entry| entry.handles.get(handle_id))
                        .filter(|handle| handle.tool_call == original_tool_call)
                        .ok_or(LiveError::Unknown)?;
                    if registration.is_some_and(|previous| previous != handle.registration) {
                        return Err(LiveError::Unknown);
                    }
                    registration = Some(handle.registration);
                    match handle.state {
                        HandleState::Ended => {
                            return Ok(if requested {
                                HandleStop::Stopped
                            } else {
                                HandleStop::AlreadyStoppingOrEnded
                            });
                        }
                        HandleState::Unknown => return Err(LiveError::StopUnconfirmed),
                        HandleState::Active => requested |= handle.request_stop(),
                    }
                }
                changed.await;
            }
        };
        tokio::time::timeout(deadline, wait)
            .await
            .map_err(|_| LiveError::StopUnconfirmed)?
    }
    /// Deadline never aborts the completion owner. A later call can observe real
    /// idle; the admission fence and unknown handles survive the timeout.
    pub async fn drain(
        &self,
        execution: &impl LiveExecutionIdentity,
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
        execution: &impl LiveExecutionIdentity,
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
        execution: &impl LiveExecutionIdentity,
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
    registration: u64,
    ended: bool,
}
impl Drop for HandleGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.inner.state.lock() {
            if let Some(handle) = state
                .entries
                .get_mut(&self.key)
                .and_then(|e| e.handles.get_mut(&self.handle_id))
                .filter(|h| h.registration == self.registration)
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

#[cfg(test)]
mod tests {
    use super::*;
    use peer_protocol::ConversationExecutionIdentity;
    fn conversation(stream: &str) -> ConversationExecutionIdentity {
        ConversationExecutionIdentity {
            conversation_id: "c".into(),
            stream_id: stream.into(),
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn scoped_stop_awaits_the_real_owner_without_cancelling_another_stream() {
        let registry = ExecutionRegistry::default();
        let first = conversation("first");
        let second = conversation("second");
        let first_attempt = registry.begin(&first).unwrap();
        let second_attempt = registry.begin(&second).unwrap();
        let first_cancel = CancellationToken::new();
        let second_cancel = CancellationToken::new();
        let (release, released) = tokio::sync::oneshot::channel();
        let cleanup = first_cancel.clone();
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("20")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        registry
            .track_handle(
                &first,
                "shell",
                "origin",
                first_cancel.clone(),
                async move {
                    cleanup.cancelled().await;
                    released.await.map_err(|_| ())?;
                    child.start_kill().map_err(|_| ())?;
                    child.wait().await.map_err(|_| ())?;
                    Ok(())
                },
            )
            .unwrap();
        let background = second_cancel.clone();
        registry
            .track_handle(
                &second,
                "shell",
                "origin",
                second_cancel.clone(),
                async move {
                    background.cancelled().await;
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(
            registry
                .stop_owned_handle(&first, "shell", "foreign", Duration::from_secs(1))
                .await,
            Err(LiveError::Unknown)
        );
        assert!(!first_cancel.is_cancelled() && !second_cancel.is_cancelled());
        assert_eq!(
            registry
                .stop_owned_handle(&first, "shell", "origin", Duration::from_millis(15))
                .await,
            Err(LiveError::StopUnconfirmed)
        );
        assert!(first_cancel.is_cancelled() && !second_cancel.is_cancelled());
        assert_eq!(registry.handle_observations(&first).unwrap()[0].2, "active");
        release.send(()).unwrap();
        assert_eq!(
            registry
                .stop_owned_handle(&first, "shell", "origin", Duration::from_secs(2))
                .await,
            Ok(HandleStop::AlreadyStoppingOrEnded)
        );
        assert_eq!(registry.handle_observations(&first).unwrap()[0].2, "ended");
        assert_eq!(
            registry.handle_observations(&second).unwrap()[0].2,
            "active"
        );
        registry.acknowledge_ended_handle(&first, "shell").unwrap();
        assert_eq!(
            registry
                .stop_owned_handle(&first, "shell", "origin", Duration::from_secs(1))
                .await,
            Err(LiveError::Unknown)
        );
        assert!(registry.admission_open(&first).unwrap());
        assert_eq!(
            registry
                .stop_owned_handle(&second, "shell", "origin", Duration::from_secs(1))
                .await,
            Ok(HandleStop::Stopped),
        );
        first_attempt.finish();
        second_attempt.finish();
        registry
            .drain(&second, Duration::from_secs(1))
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn ordinary_principals_are_isolated_and_only_real_completed_owners_can_be_evicted() {
        let registry = ExecutionRegistry::default();
        let a = conversation("a");
        let b = conversation("b");
        let first = registry.begin(&a).unwrap();
        let second = registry.begin(&b).unwrap();
        let cancelled_a = first.cancellation();
        let cancelled_b = second.cancellation();
        assert_eq!(registry.forget_ended(&a), Err(LiveError::StopUnconfirmed));
        registry.close_admission(&a).unwrap();
        assert!(cancelled_a.is_cancelled());
        assert!(!cancelled_b.is_cancelled());
        first.finish();
        registry.drain(&a, Duration::from_secs(1)).await.unwrap();
        registry.forget_ended(&a).unwrap();
        assert_eq!(registry.ownership(&a).unwrap(), Ownership::Unknown);
        assert!(registry.admission_open(&b).unwrap());
        drop(second);
        registry.close_admission(&b).unwrap();
        assert_eq!(registry.forget_ended(&b), Err(LiveError::StopUnconfirmed));
        assert_eq!(registry.ownership(&b).unwrap(), Ownership::Unknown);
        // Repeated healthy streams cannot accumulate an unbounded registry.
        for i in 0..1024 {
            let execution = conversation(&format!("healthy-{i}"));
            let attempt = registry.begin(&execution).unwrap();
            registry.close_admission(&execution).unwrap();
            attempt.finish();
            registry.forget_ended(&execution).unwrap();
        }
        assert_eq!(registry.inner.state.lock().unwrap().entries.len(), 1);
    }
}
