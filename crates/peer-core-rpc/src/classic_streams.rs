//! Bounded in-memory stream registry for Classic Chat/Plan streams.
//! Maintains active streaming state, reattach snapshots (including 5-minute
//! terminal retention), and pending permission approval waiters.

use peer_runtime::{CancellationToken, session_host::LocalPermissionDecision};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

const MAX_STREAMS: usize = 256;
const TERMINAL_RETENTION: Duration = Duration::from_secs(300);

pub struct PendingPermission {
    pub tool_call_id: String,
    pub call: Value,
    pub reply: Option<oneshot::Sender<LocalPermissionDecision>>,
}

struct StreamEntry {
    stream_id: String,
    conversation_id: String,
    assistant_message_id: String,
    started_at_ms: i64,
    running: bool,
    terminal_status: Option<String>,
    interrupted: bool,
    ended_at: Option<Instant>,
    accumulated_text: String,
    accumulated_thinking: String,
    segments: Vec<Value>,
    tool_started_at: HashMap<String, i64>,
    usage: Option<Value>,
    lifetime_usage: Option<Value>,
    cancel: CancellationToken,
    pending_permissions: HashMap<String, PendingPermission>,
}

#[derive(Default)]
struct RegistryInner {
    order: Vec<String>,
    streams: HashMap<String, StreamEntry>,
}

#[derive(Clone, Default)]
pub struct ClassicStreamRegistry {
    inner: Arc<Mutex<RegistryInner>>,
}

pub fn now_epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

impl RegistryInner {
    fn prune_expired(&mut self, now: Instant) {
        let expired: Vec<String> = self
            .streams
            .iter()
            .filter(|(_, entry)| {
                !entry.running
                    && entry.ended_at.is_some_and(|ended| {
                        now.saturating_duration_since(ended) > TERMINAL_RETENTION
                    })
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !expired.is_empty() {
            for id in &expired {
                self.streams.remove(id);
            }
            let removed: HashSet<&str> = expired.iter().map(String::as_str).collect();
            self.order.retain(|id| !removed.contains(id.as_str()));
        }

        while self.streams.len() > MAX_STREAMS {
            if let Some(pos) = self
                .order
                .iter()
                .position(|id| self.streams.get(id).is_some_and(|e| !e.running))
            {
                let id = self.order.remove(pos);
                self.streams.remove(&id);
            } else {
                break;
            }
        }
    }
}

impl ClassicStreamRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_stream(
        &self,
        stream_id: &str,
        conversation_id: &str,
        assistant_message_id: &str,
        cancel: CancellationToken,
    ) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().map_err(|_| "registry_poisoned")?;
        inner.prune_expired(Instant::now());
        if inner
            .streams
            .get(stream_id)
            .is_some_and(|existing| existing.running)
        {
            return Err("duplicate_active_stream");
        }
        if inner.streams.contains_key(stream_id) {
            inner.streams.remove(stream_id);
            inner.order.retain(|id| id != stream_id);
        }
        inner.order.push(stream_id.to_owned());
        inner.streams.insert(
            stream_id.to_owned(),
            StreamEntry {
                stream_id: stream_id.to_owned(),
                conversation_id: conversation_id.to_owned(),
                assistant_message_id: assistant_message_id.to_owned(),
                started_at_ms: now_epoch_ms(),
                running: true,
                terminal_status: None,
                interrupted: false,
                ended_at: None,
                accumulated_text: String::new(),
                accumulated_thinking: String::new(),
                segments: Vec::new(),
                tool_started_at: HashMap::new(),
                usage: None,
                lifetime_usage: None,
                cancel,
                pending_permissions: HashMap::new(),
            },
        );
        Ok(())
    }

    pub fn append_text_delta(&self, stream_id: &str, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
            && entry.running
        {
            entry.accumulated_text.push_str(delta);
            if let Some(last) = entry.segments.last_mut()
                && last["type"] == "text"
                && let Some(prev) = last["content"].as_str()
            {
                let mut combined = String::with_capacity(prev.len() + delta.len());
                combined.push_str(prev);
                combined.push_str(delta);
                last["content"] = json!(combined);
                return;
            }
            entry
                .segments
                .push(json!({ "type": "text", "content": delta }));
        }
    }

    pub fn append_thinking_delta(&self, stream_id: &str, delta: &str, kind: &str) {
        if delta.is_empty() {
            return;
        }
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
            && entry.running
        {
            entry.accumulated_thinking.push_str(delta);
            if let Some(last) = entry.segments.last_mut()
                && last["type"] == "thinking"
                && last["kind"].as_str().unwrap_or("") == kind
                && let Some(prev) = last["content"].as_str()
            {
                let mut combined = String::with_capacity(prev.len() + delta.len());
                combined.push_str(prev);
                combined.push_str(delta);
                last["content"] = json!(combined);
                return;
            }
            entry
                .segments
                .push(json!({ "type": "thinking", "content": delta, "kind": kind }));
        }
    }

    pub fn record_tool_prepared(
        &self,
        stream_id: &str,
        tool_call_id: &str,
        tool: &str,
        display_name: &str,
        args: &Value,
    ) -> i64 {
        let started_at_ms = now_epoch_ms();
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
        {
            entry
                .tool_started_at
                .insert(tool_call_id.to_owned(), started_at_ms);
            entry.segments.push(json!({
                "type": "tool-call",
                "tool": tool,
                "displayName": display_name,
                "args": args,
                "toolCallId": tool_call_id,
                "startedAtMs": started_at_ms,
            }));
        }
        started_at_ms
    }

    pub fn record_tool_settled(
        &self,
        stream_id: &str,
        tool_call_id: &str,
        stream_result: &str,
    ) -> (Option<i64>, i64, Option<i64>) {
        let ended_at_ms = now_epoch_ms();
        let mut started_at_ms = None;
        let mut duration_ms = None;
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
        {
            started_at_ms = entry.tool_started_at.get(tool_call_id).copied();
            if let Some(start) = started_at_ms {
                duration_ms = Some((ended_at_ms - start).max(0));
            }
            for seg in entry.segments.iter_mut().rev() {
                if seg["type"] == "tool-call"
                    && seg["toolCallId"].as_str() == Some(tool_call_id)
                    && seg.get("result").is_none()
                {
                    seg["result"] = json!(stream_result);
                    if let Some(start) = started_at_ms {
                        seg["startedAtMs"] = json!(start);
                    }
                    seg["endedAtMs"] = json!(ended_at_ms);
                    if let Some(dur) = duration_ms {
                        seg["durationMs"] = json!(dur);
                    }
                    break;
                }
            }
        }
        (started_at_ms, ended_at_ms, duration_ms)
    }

    pub fn record_usage(&self, stream_id: &str, usage: Value) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
        {
            entry.usage = Some(usage);
        }
    }

    pub fn register_permission_waiter(
        &self,
        stream_id: &str,
        tool_call_id: &str,
        call: Value,
        reply: oneshot::Sender<LocalPermissionDecision>,
    ) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
        {
            entry.pending_permissions.insert(
                tool_call_id.to_owned(),
                PendingPermission {
                    tool_call_id: tool_call_id.to_owned(),
                    call,
                    reply: Some(reply),
                },
            );
        }
    }

    pub fn clear_permission_waiter(&self, stream_id: &str, tool_call_id: &str) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(entry) = inner.streams.get_mut(stream_id)
        {
            entry.pending_permissions.remove(tool_call_id);
        }
    }

    pub fn decide_permission(
        &self,
        tool_call_id: &str,
        decision: LocalPermissionDecision,
    ) -> Result<bool, &'static str> {
        let sender = {
            let mut inner = self.inner.lock().map_err(|_| "registry_poisoned")?;
            let mut found = None;
            for entry in inner.streams.values_mut() {
                if let Some(mut perm) = entry.pending_permissions.remove(tool_call_id) {
                    found = perm.reply.take();
                    break;
                }
            }
            found
        };
        if let Some(tx) = sender {
            Ok(tx.send(decision).is_ok())
        } else {
            Ok(false)
        }
    }

    pub fn finish_stream(
        &self,
        stream_id: &str,
        terminal_status: &str,
        interrupted: bool,
        usage: Option<Value>,
        lifetime_usage: Option<Value>,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            let now = Instant::now();
            if let Some(entry) = inner.streams.get_mut(stream_id) {
                if !entry.running {
                    return;
                }
                entry.running = false;
                entry.terminal_status = Some(terminal_status.to_owned());
                entry.interrupted = interrupted;
                entry.ended_at = Some(now);
                if usage.is_some() {
                    entry.usage = usage;
                }
                if lifetime_usage.is_some() {
                    entry.lifetime_usage = lifetime_usage;
                }
                entry.pending_permissions.clear();

                let dangling_note = match terminal_status {
                    "aborted" => Some("工具调用已中断（生成停止）"),
                    "error" => Some("工具调用已中断（连接出错）"),
                    "done" => Some("工具结果未返回（本轮已结束）"),
                    _ => None,
                };
                if let Some(note) = dangling_note {
                    for seg in &mut entry.segments {
                        if seg["type"] == "tool-call" && seg.get("result").is_none() {
                            seg["result"] = json!(note);
                        }
                    }
                }
            }
            inner.prune_expired(now);
        }
    }

    pub fn abort_stream(&self, stream_id: &str) -> Option<(String, CancellationToken)> {
        let mut inner = self.inner.lock().ok()?;
        let entry = inner.streams.get_mut(stream_id)?;
        if !entry.running {
            return None;
        }
        entry.cancel.cancel();
        for (_, mut perm) in entry.pending_permissions.drain() {
            if let Some(tx) = perm.reply.take() {
                let _ = tx.send(LocalPermissionDecision::Cancel);
            }
        }
        Some((entry.conversation_id.clone(), entry.cancel.clone()))
    }

    pub fn cancel_all(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            for entry in inner.streams.values_mut() {
                entry.cancel.cancel();
                for (_, mut perm) in entry.pending_permissions.drain() {
                    if let Some(tx) = perm.reply.take() {
                        let _ = tx.send(LocalPermissionDecision::Cancel);
                    }
                }
            }
        }
    }

    pub fn reattach(&self, stream_id: Option<&str>, conversation_id: Option<&str>) -> Value {
        let Ok(mut inner) = self.inner.lock() else {
            return Value::Null;
        };
        inner.prune_expired(Instant::now());

        let selected_id = if let Some(sid) = stream_id.filter(|s| !s.is_empty()) {
            inner.streams.get(sid).map(|e| e.stream_id.clone())
        } else if let Some(cid) = conversation_id.filter(|s| !s.is_empty()) {
            inner
                .order
                .iter()
                .rev()
                .find_map(|id| {
                    let e = inner.streams.get(id)?;
                    (e.conversation_id == cid && e.running).then(|| id.clone())
                })
                .or_else(|| {
                    inner.order.iter().rev().find_map(|id| {
                        let e = inner.streams.get(id)?;
                        (e.conversation_id == cid).then(|| id.clone())
                    })
                })
        } else {
            let active: Vec<&StreamEntry> = inner.streams.values().filter(|e| e.running).collect();
            if active.len() == 1 {
                Some(active[0].stream_id.clone())
            } else {
                None
            }
        };

        let Some(entry) = selected_id.and_then(|id| inner.streams.get(&id)) else {
            return Value::Null;
        };

        let pending_permissions: Vec<Value> = entry
            .pending_permissions
            .values()
            .map(|p| {
                json!({
                    "toolCallId": p.tool_call_id,
                    "streamId": entry.stream_id,
                    "call": p.call,
                })
            })
            .collect();

        json!({
            "streamId": entry.stream_id,
            "conversationId": entry.conversation_id,
            "assistantMessageId": entry.assistant_message_id,
            "startedAt": entry.started_at_ms,
            "accumulatedText": entry.accumulated_text,
            "accumulatedThinking": entry.accumulated_thinking,
            "segments": entry.segments,
            "isStreaming": entry.running,
            "terminalStatus": if entry.running { Value::Null } else { json!(entry.terminal_status) },
            "interrupted": if entry.running { false } else { entry.interrupted },
            "usage": entry.usage,
            "lifetimeUsage": entry.lifetime_usage,
            "pendingPermissions": pending_permissions,
        })
    }

    pub fn list_active(&self) -> Value {
        let Ok(mut inner) = self.inner.lock() else {
            return json!({ "conversationIds": [], "streams": [] });
        };
        inner.prune_expired(Instant::now());
        let mut conversation_ids = Vec::new();
        let mut seen_cids = HashSet::new();
        let mut streams = Vec::new();
        for id in &inner.order {
            if let Some(entry) = inner.streams.get(id)
                && entry.running
            {
                if seen_cids.insert(entry.conversation_id.clone()) {
                    conversation_ids.push(entry.conversation_id.clone());
                }
                streams.push(json!({
                    "streamId": entry.stream_id,
                    "conversationId": entry.conversation_id,
                    "startedAt": entry.started_at_ms,
                }));
            }
        }
        json!({
            "conversationIds": conversation_ids,
            "streams": streams,
        })
    }
}
