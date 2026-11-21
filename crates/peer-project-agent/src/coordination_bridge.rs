//! Coordination V2 Runtime Bridge (`peer_store::CoordinationStore` +
//! `peer_runtime::coordination::NativeCoordinationReducer`).
//!
//! Owns the per-workspace fenced `CoordinationStore` lifecycle (lease token custody,
//! lazy journal initialization/checkpoint repair, work/mandate tracking, working-context
//! notes/handoffs, and durable parent<->child agent communication mailboxes).

use crate::{ProjectError, memory_secret_reason, now_iso, parse_iso_ms};
use peer_runtime::coordination::NativeCoordinationReducer;
use peer_store::{CoordinationError, CoordinationSnapshot, CoordinationStore, LeaseToken};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

const MAX_CONTEXT_NOTES: usize = 8;
const MAX_NOTE_CLIP_CHARS: usize = 2_000;
const MAX_TOTAL_NOTE_CHARS: usize = 6_000;
const MAX_AGENT_MSG_COUNT: usize = 8;
const MAX_AGENT_MSG_TOTAL_CHARS: usize = 12_000;
const MAX_AGENT_MSG_ITEM_CHARS: usize = 4_000;

fn map_coord_err(err: CoordinationError) -> ProjectError {
    ProjectError::new(err.code(), err.to_string())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn sha256_json(value: &Value) -> String {
    let encoded = peer_protocol::javascript_json_string(value)
        .unwrap_or_else(|_| serde_json::to_string(value).unwrap_or_default());
    sha256_hex(encoded.as_bytes())
}

pub fn coordination_work_id(conversation_id: &str, keys: &[String]) -> String {
    let hex = sha256_json(&json!([conversation_id, keys]));
    format!("work-{}", &hex[..24])
}

pub struct CommitAgentMessageRequest<'a> {
    pub work_id: &'a str,
    pub session_id: &'a str,
    pub direction: &'a str,
    pub purpose: &'a str,
    pub text: &'a str,
    pub sender_conversation_id: &'a str,
    pub recipient_conversation_id: &'a str,
    pub ensure_turn: bool,
    pub goal_revision: Option<u64>,
    pub execution_epoch: Option<&'a str>,
    pub reply_to: Option<&'a str>,
    pub decision_answer: Option<&'a Value>,
    pub delivery_key: &'a str,
}

#[derive(Default)]
pub struct CoordinationHub {
    stores: Mutex<HashMap<String, CoordinationStore>>,
}

impl CoordinationHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert_lease(&self, workspace_id: &str, token: LeaseToken) {
        if let Ok(mut guard) = self.stores.lock() {
            guard.insert(workspace_id.to_owned(), CoordinationStore::new(token));
        }
    }

    pub fn heartbeat(&self, workspace_id: &str, now_ms: i64) -> Result<bool, ProjectError> {
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let Some(store) = guard.get_mut(workspace_id) else {
            return Ok(false);
        };
        if store.heartbeat(now_ms).is_ok() {
            Ok(true)
        } else {
            guard.remove(workspace_id);
            Ok(false)
        }
    }

    pub fn holds(&self, workspace_id: &str) -> bool {
        self.stores
            .lock()
            .map(|g| g.contains_key(workspace_id))
            .unwrap_or(false)
    }

    pub fn takeover_requested(&self, workspace_id: &str) -> bool {
        self.stores
            .lock()
            .ok()
            .and_then(|g| {
                g.get(workspace_id)
                    .map(|s| s.lease().takeover_requested().unwrap_or(false))
            })
            .unwrap_or(false)
    }

    pub fn release(&self, workspace_id: &str) -> Result<(), ProjectError> {
        let removed = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?
            .remove(workspace_id);
        if let Some(store) = removed {
            store.into_lease().release()?;
        }
        Ok(())
    }

    pub fn release_all(&self) {
        if let Ok(mut guard) = self.stores.lock() {
            for (_, store) in guard.drain() {
                let _ = store.into_lease().release();
            }
        }
    }

    fn ensure_prepared_locked(
        store: &mut CoordinationStore,
    ) -> Result<CoordinationSnapshot, ProjectError> {
        let mut snap = store
            .initialize(&NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        if snap.state["revision"].as_u64() != Some(snap.durable_head_revision) {
            snap = store
                .checkpoint_head(&snap, &NativeCoordinationReducer, None)
                .map_err(map_coord_err)?;
        }
        Ok(snap)
    }

    pub fn ensure_snapshot(
        &self,
        workspace_id: &str,
    ) -> Result<CoordinationSnapshot, ProjectError> {
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        Self::ensure_prepared_locked(store)
    }

    pub fn append_event(
        &self,
        workspace_id: &str,
        event: Value,
    ) -> Result<CoordinationSnapshot, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;
        store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)
    }

    pub fn read_state(&self, workspace_id: &str) -> Result<Value, ProjectError> {
        Ok(self.ensure_snapshot(workspace_id)?.state)
    }

    pub fn read_work(
        &self,
        workspace_id: &str,
        work_id: &str,
    ) -> Result<Option<Value>, ProjectError> {
        let state = self.read_state(workspace_id)?;
        let work = &state["works"][work_id];
        Ok((!work.is_null()).then(|| work.clone()))
    }

    pub fn ensure_work(
        &self,
        workspace_id: &str,
        work_id: &str,
        parent_conversation_id: &str,
        anchor_input_ids: &[String],
        session_ids: &[String],
        state_label: &str,
    ) -> Result<Value, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;
        let existing = &snap.state["works"][work_id];
        let event = if existing.is_null() {
            json!({
                "kind": "work",
                "work": {
                    "workId": work_id,
                    "schemaVersion": 1,
                    "workspaceId": workspace_id,
                    "parentConversationId": parent_conversation_id,
                    "anchorInputIds": anchor_input_ids,
                    "sessionIds": session_ids,
                    "state": state_label,
                }
            })
        } else {
            let mut merged_sessions: Vec<String> = existing["sessionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let mut seen: HashSet<String> = merged_sessions.iter().cloned().collect();
            for sid in session_ids {
                if !sid.is_empty() && seen.insert(sid.clone()) {
                    merged_sessions.push(sid.clone());
                }
            }
            let same_state = existing["state"].as_str() == Some(state_label);
            let same_sessions = existing["sessionIds"]
                .as_array()
                .is_some_and(|a| a.len() == merged_sessions.len());
            if same_state && same_sessions {
                return Ok(existing.clone());
            }
            json!({
                "kind": "work_updated",
                "workId": work_id,
                "work": {
                    "sessionIds": merged_sessions,
                    "state": state_label,
                }
            })
        };
        let next = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok(next.state["works"][work_id].clone())
    }

    pub fn read_work_notes(
        &self,
        workspace_id: &str,
        work_id: &str,
        conversation_id: Option<&str>,
        note_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Value>, ProjectError> {
        let state = self.read_state(workspace_id)?;
        let notes_map = state["workNotes"].as_object();
        let Some(notes) = notes_map else {
            return Ok(Vec::new());
        };
        if let Some(nid) = note_id.map(str::trim).filter(|s| !s.is_empty()) {
            let Some(note) = notes.get(nid) else {
                return Ok(Vec::new());
            };
            if note["workId"].as_str() != Some(work_id)
                || conversation_id.is_some_and(|cid| note["conversationId"].as_str() != Some(cid))
            {
                return Ok(Vec::new());
            }
            return Ok(vec![note.clone()]);
        }
        let mut rows: Vec<Value> = notes
            .values()
            .filter(|n| {
                n["workId"].as_str() == Some(work_id)
                    && conversation_id.is_none_or(|cid| n["conversationId"].as_str() == Some(cid))
            })
            .cloned()
            .collect();
        rows.sort_by(|a, b| {
            b["at"]
                .as_str()
                .unwrap_or("")
                .cmp(a["at"].as_str().unwrap_or(""))
                .then_with(|| {
                    b["revision"]
                        .as_u64()
                        .unwrap_or(0)
                        .cmp(&a["revision"].as_u64().unwrap_or(0))
                })
        });
        rows.truncate(limit.clamp(1, 50));
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write_work_note(
        &self,
        workspace_id: &str,
        work_id: &str,
        conversation_id: &str,
        name: &str,
        text: &str,
        expected_revision: u64,
        source_refs: Vec<String>,
        operation_id: &str,
    ) -> Result<(Value, bool), ProjectError> {
        let valid_name = !name.is_empty()
            && name.chars().count() <= 120
            && name
                .chars()
                .all(|c| c.is_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-'));
        if !valid_name || text.trim().is_empty() || text.chars().count() > 12_000 {
            return Err(ProjectError::code("work_note_invalid"));
        }
        if memory_secret_reason(text).is_some() {
            return Err(ProjectError::code("working_context_sensitive"));
        }
        let note_id = format!(
            "note-{}",
            sha256_json(&json!([work_id, conversation_id, name]))
        );
        let payload_hash = sha256_json(&json!([name, text, source_refs, expected_revision]));

        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;
        let prev = &snap.state["workNotes"][&note_id];
        if !prev.is_null() && prev["operationId"].as_str() == Some(operation_id) {
            if prev["payloadHash"].as_str() != Some(payload_hash.as_str()) {
                return Err(ProjectError::code("work_note_operation_conflict"));
            }
            return Ok((prev.clone(), true));
        }

        let event = json!({
            "kind": "work_note_written",
            "operationId": operation_id,
            "expectedRevision": expected_revision,
            "note": {
                "noteId": note_id,
                "name": name,
                "text": text,
                "workId": work_id,
                "conversationId": conversation_id,
                "operationId": operation_id,
                "payloadHash": payload_hash,
                "sourceRefs": source_refs,
                "at": now_iso(),
            }
        });
        let next = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok((next.state["workNotes"][&note_id].clone(), false))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_context_handoff(
        &self,
        workspace_id: &str,
        work_id: &str,
        conversation_id: &str,
        hint: &str,
        previous_window_id: Option<&str>,
        history_cursor: Option<&str>,
        operation_id: &str,
    ) -> Result<(Value, bool), ProjectError> {
        if hint.trim().is_empty()
            || hint.chars().count() > 6_000
            || memory_secret_reason(hint).is_some()
        {
            return Err(ProjectError::code("context_hint_invalid"));
        }

        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;

        if let Some(prev_id) = previous_window_id {
            let prev = &snap.state["contextWindows"][prev_id];
            if prev.is_null()
                || prev["workId"].as_str() != Some(work_id)
                || prev["conversationId"].as_str() != Some(conversation_id)
            {
                return Err(ProjectError::code("context_window_out_of_scope"));
            }
        }

        let window_id = format!(
            "window-{}",
            sha256_json(&json!([work_id, conversation_id, operation_id]))
        );
        let payload_hash = sha256_json(&json!([hint, previous_window_id, history_cursor]));
        let existing = &snap.state["contextWindows"][&window_id];
        if !existing.is_null() {
            if existing["payloadHash"].as_str() != Some(payload_hash.as_str()) {
                return Err(ProjectError::code("context_window_operation_conflict"));
            }
            return Ok((existing.clone(), true));
        }

        let mut work_sessions: HashSet<String> = snap.state["works"][work_id]["sessionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if let Some(pending) = snap.state["works"][work_id]["pendingEventIds"].as_array() {
            for ev_id in pending.iter().filter_map(Value::as_str) {
                if let Some(sid) = snap.state["events"][ev_id]["event"]["sessionId"].as_str() {
                    work_sessions.insert(sid.to_owned());
                }
            }
        }
        let mut obligation_refs = vec![format!("work:{work_id}")];
        if let Some(reqs) = snap.state["agentRequests"].as_object() {
            for r in reqs.values() {
                if r["status"] == "open"
                    && (r["workId"].as_str() == Some(work_id)
                        || r["sessionId"]
                            .as_str()
                            .is_some_and(|s| work_sessions.contains(s)))
                    && let Some(rid) = r["requestId"].as_str()
                {
                    obligation_refs.push(rid.to_owned());
                }
            }
        }

        let mut window_obj = Map::new();
        window_obj.insert("windowId".into(), json!(window_id));
        window_obj.insert("workId".into(), json!(work_id));
        window_obj.insert("conversationId".into(), json!(conversation_id));
        window_obj.insert("hint".into(), json!(hint));
        window_obj.insert("budgetRef".into(), json!(work_id));
        window_obj.insert("state".into(), json!("prepared"));
        window_obj.insert("payloadHash".into(), json!(payload_hash));
        window_obj.insert("obligationRefs".into(), json!(obligation_refs));
        window_obj.insert("at".into(), json!(now_iso()));
        if let Some(prev) = previous_window_id {
            window_obj.insert("previousWindowId".into(), json!(prev));
        }
        if let Some(cursor) = history_cursor {
            window_obj.insert("historyCursor".into(), json!(cursor));
        }
        let window_val = Value::Object(window_obj);

        let event = json!({
            "kind": "context_window_opened",
            "operationId": operation_id,
            "window": window_val,
        });
        let next = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok((next.state["contextWindows"][&window_id].clone(), false))
    }

    pub fn read_working_context(
        &self,
        workspace_id: &str,
        work_id: &str,
        conversation_id: &str,
    ) -> Option<Value> {
        let state = self.read_state(workspace_id).ok()?;
        let mut remaining = MAX_TOTAL_NOTE_CHARS;
        let notes_raw = self
            .read_work_notes(
                workspace_id,
                work_id,
                Some(conversation_id),
                None,
                MAX_CONTEXT_NOTES,
            )
            .ok()
            .unwrap_or_default();
        let mut bounded_notes = Vec::new();
        for mut note in notes_raw {
            let text = note["text"].as_str().unwrap_or("");
            let take = MAX_NOTE_CLIP_CHARS.min(remaining);
            let clipped: String = text.chars().take(take).collect();
            let char_len = clipped.chars().count();
            if char_len == 0 {
                continue;
            }
            remaining = remaining.saturating_sub(char_len);
            note["text"] = json!(clipped);
            bounded_notes.push(note);
        }

        let mut windows: Vec<Value> = state["contextWindows"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, v)| v.clone())
            .filter(|w| {
                w["workId"].as_str() == Some(work_id)
                    && w["conversationId"].as_str() == Some(conversation_id)
            })
            .collect();
        windows.sort_by(|a, b| {
            b["at"]
                .as_str()
                .unwrap_or("")
                .cmp(a["at"].as_str().unwrap_or(""))
        });
        let latest_window = windows.into_iter().next();

        if bounded_notes.is_empty() && latest_window.is_none() {
            return None;
        }

        let mut obligation_refs = vec![format!("work:{work_id}")];
        if let Some(ref win) = latest_window
            && let Some(arr) = win["obligationRefs"].as_array()
        {
            for r in arr.iter().filter_map(Value::as_str) {
                if !obligation_refs.iter().any(|x| x == r) {
                    obligation_refs.push(r.to_owned());
                }
            }
        }
        let mut out = json!({
            "workId": work_id,
            "notes": bounded_notes,
            "obligationRefs": obligation_refs,
            "budgetRef": work_id,
        });
        if let Some(win) = latest_window {
            out["windowId"] = win["windowId"].clone();
            out["hint"] = win["hint"].clone();
            if !win["historyCursor"].is_null() {
                out["historyCursor"] = win["historyCursor"].clone();
            }
        }
        Some(out)
    }

    pub fn commit_agent_message(
        &self,
        workspace_id: &str,
        req: CommitAgentMessageRequest<'_>,
    ) -> Result<(Value, bool), ProjectError> {
        if !matches!(req.direction, "parent_to_child" | "child_to_parent")
            || !matches!(req.purpose, "update" | "question" | "answer")
            || req.text.trim().is_empty()
            || req.text.chars().count() > 4_000
        {
            return Err(ProjectError::code("invalid_input"));
        }

        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;

        let mandate_rev = req.goal_revision.unwrap_or_else(|| {
            snap.state["mandates"][req.work_id]["goalRevision"]
                .as_u64()
                .unwrap_or(0)
        });
        let exec_epoch = req
            .execution_epoch
            .map(str::to_owned)
            .unwrap_or_else(|| format!("ep-{mandate_rev}"));
        let message_id = format!(
            "agent-msg:{}",
            sha256_json(&json!([
                req.delivery_key,
                req.sender_conversation_id,
                req.recipient_conversation_id,
                req.session_id,
                req.purpose,
                req.text,
                req.reply_to
            ]))
        );
        let operation_id = format!(
            "op-{}",
            sha256_json(&json!([message_id, req.session_id, req.purpose]))
        );
        let payload_hash = sha256_json(&json!([
            req.work_id,
            req.session_id,
            mandate_rev,
            req.purpose,
            req.text,
            req.reply_to
        ]));

        let existing = &snap.state["agentMessages"][&message_id];
        if !existing.is_null() {
            if existing["payloadHash"].as_str() != Some(payload_hash.as_str()) {
                return Err(ProjectError::code("agent_operation_conflict"));
            }
            return Ok((existing.clone(), true));
        }

        let delivery_intent = if req.ensure_turn {
            "ensure_turn"
        } else {
            "mailbox_only"
        };
        let mut msg = json!({
            "messageId": message_id,
            "operationId": operation_id,
            "payloadHash": payload_hash,
            "workId": req.work_id,
            "sessionId": req.session_id,
            "goalRevision": mandate_rev,
            "direction": req.direction,
            "purpose": req.purpose,
            "text": req.text,
            "senderConversationId": req.sender_conversation_id,
            "recipientConversationId": req.recipient_conversation_id,
            "deliveryIntent": delivery_intent,
            "at": now_iso(),
        });
        if let Some(rt) = req.reply_to {
            msg["replyTo"] = json!(rt);
        }

        let receipt = json!({
            "operationId": operation_id,
            "messageId": message_id,
            "sessionId": req.session_id,
            "goalRevision": mandate_rev,
            "executionEpoch": exec_epoch,
            "delivery": "queued",
            "admission": if req.ensure_turn { "pending" } else { "not_requested" },
            "effect": if req.ensure_turn { "pending" } else { "not_requested" },
        });

        let mut event = json!({
            "kind": "agent_message_committed",
            "message": msg,
            "receipt": receipt,
        });
        if req.direction == "child_to_parent" && req.purpose == "question" {
            event["request"] = json!({
                "requestId": message_id,
                "revision": 1,
                "status": "open",
                "responder": "parent",
                "sessionId": req.session_id,
                "goalRevision": mandate_rev,
                "workId": req.work_id,
                "parentConversationId": req.recipient_conversation_id,
            });
        }
        if let Some(ans) = req.decision_answer {
            event["answer"] = ans.clone();
        }

        let next = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok((next.state["agentMessages"][&message_id].clone(), false))
    }

    pub fn read_agent_messages_for_context(
        &self,
        workspace_id: &str,
        conversation_id: &str,
    ) -> Vec<Value> {
        let Ok(state) = self.read_state(workspace_id) else {
            return Vec::new();
        };
        let Some(msgs_map) = state["agentMessages"].as_object() else {
            return Vec::new();
        };
        let cmds_map = state["agentCommands"].as_object();
        let reqs_map = state["agentRequests"].as_object();

        let mut rows: Vec<Value> = msgs_map
            .values()
            .filter(|m| {
                m["recipientConversationId"].as_str() == Some(conversation_id)
                    && matches!(
                        m["purpose"].as_str(),
                        Some("update" | "question" | "answer")
                    )
                    && matches!(
                        m["direction"].as_str(),
                        Some("parent_to_child" | "child_to_parent")
                    )
            })
            .map(|m| {
                let mut cloned = m.clone();
                if let Some(op_id) = m["operationId"].as_str()
                    && let Some(rcpt) = cmds_map.and_then(|c| c.get(op_id))
                {
                    cloned["deliveryReceipt"] = rcpt.clone();
                }
                cloned
            })
            .collect();
        rows.sort_by_key(|m| m["sequence"].as_u64().unwrap_or(0));

        let prioritized: Vec<Value> = rows
            .iter()
            .filter(|m| {
                let queued = m["deliveryIntent"] == "ensure_turn"
                    && m["deliveryReceipt"]["delivery"] == "queued";
                let open_q = m["direction"] == "child_to_parent"
                    && m["messageId"]
                        .as_str()
                        .and_then(|id| reqs_map.and_then(|r| r.get(id)))
                        .is_some_and(|r| r["status"] == "open" && r["responder"] == "parent");
                queued || open_q
            })
            .cloned()
            .collect();

        let selected: Vec<Value> = if !prioritized.is_empty() {
            prioritized.into_iter().take(MAX_AGENT_MSG_COUNT).collect()
        } else {
            let start = rows.len().saturating_sub(MAX_AGENT_MSG_COUNT);
            rows[start..].to_vec()
        };

        let mut remaining = MAX_AGENT_MSG_TOTAL_CHARS;
        let mut projected = Vec::new();
        for mut m in selected {
            let text = m["text"].as_str().unwrap_or("");
            let cap = MAX_AGENT_MSG_ITEM_CHARS.min(remaining);
            let clipped: String = text.chars().take(cap).collect();
            let count = clipped.chars().count();
            if count == 0 {
                continue;
            }
            remaining = remaining.saturating_sub(count);
            m["text"] = json!(clipped);
            projected.push(m);
        }
        projected
    }

    pub fn mark_agent_messages_observed(
        &self,
        workspace_id: &str,
        conversation_id: &str,
        message_ids: &[String],
    ) -> Result<(), ProjectError> {
        if message_ids.is_empty() {
            return Ok(());
        }
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let Some(store) = guard.get_mut(workspace_id) else {
            return Ok(());
        };
        let snap = Self::ensure_prepared_locked(store)?;
        let mut unobserved = Vec::new();
        for mid in message_ids {
            let msg = &snap.state["agentMessages"][mid];
            if msg["recipientConversationId"].as_str() != Some(conversation_id) {
                continue;
            }
            let op_id = msg["operationId"].as_str().unwrap_or("");
            if snap.state["agentCommands"][op_id]["delivery"] == "queued" {
                unobserved.push(Value::String(mid.clone()));
            }
        }
        if unobserved.is_empty() {
            return Ok(());
        }
        let event = json!({
            "kind": "agent_context_observed",
            "conversationId": conversation_id,
            "messageIds": unobserved,
        });
        let _ = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_coordination_decision(
        &self,
        workspace_id: &str,
        work_id: &str,
        action: &str,
        reason: &str,
        expected_revision: Option<u64>,
        source_input_ids: Vec<String>,
        operation_id: &str,
        session_id: Option<&str>,
    ) -> Result<Value, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut guard = self
            .stores
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        let store = guard
            .get_mut(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let snap = Self::ensure_prepared_locked(store)?;
        let prev = &snap.state["mandates"][work_id];
        let cur_rev = prev["goalRevision"].as_u64().unwrap_or(0);
        if expected_revision.is_some_and(|exp| exp != cur_rev) {
            return Err(ProjectError::code("goal_revision_conflict"));
        }
        let next_rev = cur_rev + 1;
        let lifecycle = if action == "cancel" {
            "cancelled"
        } else {
            "active"
        };
        let mut session_ids: Vec<String> = prev["sessionIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if let Some(sid) = session_id.filter(|s| !s.is_empty())
            && !session_ids.iter().any(|s| s == sid)
        {
            session_ids.push(sid.to_owned());
        }
        let revoked: Vec<String> = if action == "cancel" || action == "replace" {
            session_id.into_iter().map(str::to_owned).collect()
        } else {
            prev["revokedSessionIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        };
        let mut bindings = if prev["executionBindings"].is_object() {
            prev["executionBindings"].clone()
        } else {
            json!({})
        };
        let epoch = format!("ep-{next_rev}");
        if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
            bindings[sid] = json!({
                "workId": work_id,
                "sessionId": sid,
                "goalRevision": next_rev,
                "executionEpoch": epoch,
            });
        }

        let mandate = json!({
            "workId": work_id,
            "goalRevision": next_rev,
            "lifecycle": lifecycle,
            "sessionIds": session_ids,
            "revokedSessionIds": revoked,
            "executionBindings": bindings,
        });
        let receipt = json!({
            "operationId": operation_id,
            "expectedRevision": cur_rev,
            "sourceInputIds": source_input_ids,
            "action": action,
            "reason": reason,
        });
        let transition = json!({
            "schemaVersion": 1,
            "minimumExecutorVersion": 1,
            "phase": "completed",
            "action": action,
            "expectedGoalRevision": next_rev,
            "executionEpoch": epoch,
        });
        let event = json!({
            "kind": "coordination_decision",
            "mandate": mandate,
            "receipt": receipt,
            "transition": transition,
        });
        let next = store
            .append(&snap, &event, now_ms, &NativeCoordinationReducer, None)
            .map_err(map_coord_err)?;
        Ok(next.state["mandates"][work_id].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use peer_store::{HostIdentity, HostLeaseStore, HostSurface};
    use tempfile::tempdir;

    fn test_hub_with_lease(ws_id: &str) -> (tempfile::TempDir, CoordinationHub) {
        let dir = tempdir().unwrap();
        let identity = HostIdentity::new(
            "test-host-1",
            HostSurface::Tui,
            std::process::id(),
            "0.1.0-test",
        )
        .unwrap();
        let leases = HostLeaseStore::new(dir.path());
        let token = match leases.acquire(ws_id, &identity, 1_700_000_000_000).unwrap() {
            peer_store::AcquireLease::Acquired { token, .. } => token,
            peer_store::AcquireLease::Held(_) => panic!("expected fresh lease"),
        };
        let hub = CoordinationHub::new();
        hub.insert_lease(ws_id, token);
        (dir, hub)
    }

    #[test]
    fn coordination_hub_persists_notes_handoff_messages_and_mandates() {
        let (_dir, hub) = test_hub_with_lease("ws-coord-1");
        let work_id = coordination_work_id("conv-main", &["in-1".into()]);

        let w = hub
            .ensure_work(
                "ws-coord-1",
                &work_id,
                "conv-main",
                &["in-1".into()],
                &["sess-1".into()],
                "runnable",
            )
            .unwrap();
        assert_eq!(w["workId"], work_id);

        // Secret note is rejected
        assert_eq!(
            hub.write_work_note(
                "ws-coord-1",
                &work_id,
                "conv-main",
                "secret-note",
                "token sk-abcdef1234567890",
                0,
                vec![],
                "op-secret",
            )
            .unwrap_err()
            .code,
            "working_context_sensitive"
        );

        // Valid write, idempotent replay, and stale-revision conflict
        let (note, replayed) = hub
            .write_work_note(
                "ws-coord-1",
                &work_id,
                "conv-main",
                "plan-notes",
                "Checked src/lib.rs exports.",
                0,
                vec!["ev-1".into()],
                "op-note-1",
            )
            .unwrap();
        assert!(!replayed);
        assert_eq!(note["revision"], 1);

        let (_, replayed2) = hub
            .write_work_note(
                "ws-coord-1",
                &work_id,
                "conv-main",
                "plan-notes",
                "Checked src/lib.rs exports.",
                0,
                vec!["ev-1".into()],
                "op-note-1",
            )
            .unwrap();
        assert!(replayed2);

        let conflict = hub.write_work_note(
            "ws-coord-1",
            &work_id,
            "conv-main",
            "plan-notes",
            "Stale overwrite",
            0,
            vec![],
            "op-note-2",
        );
        assert_eq!(conflict.unwrap_err().code, "work_note_conflict");

        // Chained context handoff window + working context projection
        let (win, _) = hub
            .prepare_context_handoff(
                "ws-coord-1",
                &work_id,
                "conv-main",
                "Resume verification of module X",
                None,
                Some("cursor-42"),
                "op-win-1",
            )
            .unwrap();
        assert_eq!(win["budgetRef"], work_id);
        let proj = hub
            .read_working_context("ws-coord-1", &work_id, "conv-main")
            .unwrap();
        assert_eq!(proj["notes"].as_array().unwrap().len(), 1);
        assert_eq!(proj["windowId"], win["windowId"]);

        // Agent message commit, context read, and observed receipt transition
        let (msg, _) = hub
            .commit_agent_message(
                "ws-coord-1",
                CommitAgentMessageRequest {
                    work_id: &work_id,
                    session_id: "sess-1",
                    direction: "child_to_parent",
                    purpose: "question",
                    text: "Should I modify existing config defaults?",
                    sender_conversation_id: "sess-1",
                    recipient_conversation_id: "conv-main",
                    ensure_turn: true,
                    goal_revision: None,
                    execution_epoch: None,
                    reply_to: None,
                    decision_answer: None,
                    delivery_key: "dk-1",
                },
            )
            .unwrap();
        let inbox_msgs = hub.read_agent_messages_for_context("ws-coord-1", "conv-main");
        assert_eq!(inbox_msgs.len(), 1);
        assert_eq!(inbox_msgs[0]["deliveryReceipt"]["delivery"], "queued");
        let mid = msg["messageId"].as_str().unwrap().to_owned();
        hub.mark_agent_messages_observed("ws-coord-1", "conv-main", &[mid])
            .unwrap();
        let inbox_after = hub.read_agent_messages_for_context("ws-coord-1", "conv-main");
        assert_eq!(inbox_after[0]["deliveryReceipt"]["delivery"], "observed");

        // Coordination decision + revision conflict guard
        let m1 = hub
            .record_coordination_decision(
                "ws-coord-1",
                &work_id,
                "revise",
                "tighten test scope",
                Some(0),
                vec!["in-1".into()],
                "op-dec-1",
                Some("sess-1"),
            )
            .unwrap();
        assert_eq!(m1["goalRevision"], 1);
        let err = hub
            .record_coordination_decision(
                "ws-coord-1",
                &work_id,
                "pause",
                "stale rev",
                Some(0),
                vec![],
                "op-dec-2",
                Some("sess-1"),
            )
            .unwrap_err();
        assert_eq!(err.code, "goal_revision_conflict");

        hub.release("ws-coord-1").unwrap();
    }
}
