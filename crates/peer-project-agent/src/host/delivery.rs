//! Delivery responsibilities accompany the inbox cursor. Report/settlement failures can back off
//! independently of mailbox consumption, and a restart can reconcile against canonical history.

use super::*;
use crate::{
    WorkSessionSummary,
    inbox::{DeliveryStage, PendingDelivery},
    reply::reports_result_revision,
    wake_envelope::{is_result_delivery_event, wake_event_session_id},
};
use std::collections::BTreeMap;

const MAX_DELIVERY_EVENTS_PER_WAKE: usize = 24;

impl NativeProjectHost {
    pub(super) fn has_due_delivery(&self, workspace_id: &str, now_ms: i64) -> bool {
        self.inbox
            .read_cursor_document(workspace_id)
            .pending_deliveries
            .values()
            .any(|delivery| delivery.is_due(now_ms))
    }

    /// Discover stranded revisions at startup/maintenance, and admit current completion events
    /// before committing the inbox cursor. A report already in canonical history is settled without
    /// another model call. Digest items discharge the wake only after their own durable enqueue.
    pub(super) fn reconcile_deliveries(
        &self,
        workspace_id: &str,
        conversation_id: &str,
        now_ms: i64,
        discover_all: bool,
        events: &[Value],
    ) -> Result<Vec<WorkSessionSummary>, ProjectError> {
        let epoch = self
            .lease_epoch(workspace_id)
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let owns_lease = || self.holds_lease_generation(workspace_id, &epoch);
        let sessions = self
            .supervisor
            .pending_result_sessions(workspace_id, conversation_id);
        let previous = self
            .inbox
            .read_cursor_document(workspace_id)
            .pending_deliveries;
        let sessions: Vec<_> = sessions
            .into_iter()
            .filter(|session| {
                discover_all
                    || previous.contains_key(&session.session_id)
                    || events
                        .iter()
                        .any(|event| matches_completion(event, session))
            })
            .collect();

        if sessions.is_empty() && previous.is_empty() {
            return Ok(Vec::new());
        }

        let mut next = BTreeMap::new();
        let mut due = Vec::new();
        if !sessions.is_empty() {
            let history =
                crate::read_full_conversation_messages(&self.conversations, conversation_id)?;
            let digest = self.digests.pending_messages(workspace_id);
            for session in sessions {
                let sid = &session.session_id;
                let revision = &session.updated_at;
                let status = if history
                    .iter()
                    .any(|msg| reports_result_revision(msg, sid, revision))
                {
                    DeliveryStage::Settlement
                } else if digest
                    .iter()
                    .any(|msg| reports_result_revision(msg, sid, revision))
                {
                    DeliveryStage::Digest
                } else {
                    DeliveryStage::Wake
                };
                let mut delivery = previous
                    .get(sid)
                    .filter(|row| row.revision == *revision && row.stage == status)
                    .cloned()
                    .unwrap_or_else(|| PendingDelivery::new(revision));
                delivery.stage = status;
                match status {
                    DeliveryStage::Digest => delivery.next_attempt_ms = None,
                    DeliveryStage::Settlement if delivery.is_due(now_ms) => {
                        match self.supervisor.settle_reported_revision(
                            workspace_id,
                            sid,
                            revision,
                            owns_lease(),
                        ) {
                            Ok(decision) if decision.accepted_by.is_some() => continue,
                            Ok(_) => delivery.next_attempt_ms = None,
                            Err(error) if error.code == "session_state_changed" => continue,
                            Err(error) if error.code == "LEASE_REQUIRED" => return Err(error),
                            Err(error) => delivery.record_failure(now_ms, error.code),
                        }
                    }
                    DeliveryStage::Wake if delivery.is_due(now_ms) => {
                        due.push((delivery.next_attempt_ms, session.clone()));
                    }
                    _ => {}
                }
                next.insert(sid.clone(), delivery);
            }
        }

        if next != previous {
            if !owns_lease() {
                return Err(ProjectError::code("LEASE_REQUIRED"));
            }
            self.inbox.update_cursor_document(workspace_id, |doc| {
                // Maintenance and the foreground path can both reconcile. Preserve another
                // pass's transitions or attempt counter if it won the cursor lock first.
                doc.pending_deliveries.retain(|id, current| {
                    next.contains_key(id) || previous.get(id) != Some(current)
                });
                for (id, delivery) in next {
                    if doc.pending_deliveries.get(&id) == previous.get(&id) {
                        doc.pending_deliveries.insert(id, delivery);
                    }
                }
            })?;
        }
        due.sort_by_key(|(next, session)| (*next, session.session_id.clone()));
        Ok(due
            .into_iter()
            .take(MAX_DELIVERY_EVENTS_PER_WAKE)
            .map(|(_, session)| session)
            .collect())
    }

    pub(super) fn finish_delivery_attempt(
        &self,
        workspace_id: &str,
        attempts: &[WorkSessionSummary],
        now_ms: i64,
        outcome: &AgentTurnOutcome,
        through_seq: Option<u64>,
    ) -> Result<(), ProjectError> {
        if !self.holds_lease(workspace_id) {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        self.inbox.update_cursor_document(workspace_id, |doc| {
            if outcome.failure_hold.is_none() && !matches!(outcome.end, TurnEndKind::UserStopped) {
                for session in attempts {
                    if let Some(item) = doc.pending_deliveries.get_mut(&session.session_id)
                        && item.stage == DeliveryStage::Wake
                        && item.revision == session.updated_at
                        && item.is_due(now_ms)
                    {
                        let reason = match &outcome.end {
                            TurnEndKind::Failed { code } => code,
                            _ => "result_delivery_missing",
                        };
                        item.record_failure(now_ms, reason);
                    }
                }
            }
            if let Some(seq) = through_seq {
                doc.cursor.seq = doc.cursor.seq.max(seq);
            }
        })?;
        Ok(())
    }
}

fn matches_completion(event: &Value, session: &WorkSessionSummary) -> bool {
    (is_result_delivery_event(event) || event["kind"] == "stalled")
        && wake_event_session_id(event) == Some(&session.session_id)
        && event["payload"]["followUpEpoch"]
            .as_u64()
            .is_none_or(|epoch| epoch == session.follow_up_epoch.unwrap_or(0))
}

pub(super) fn delivery_event(session: &WorkSessionSummary, events: &[Value]) -> Value {
    let original = events.iter().find(|event| {
        is_result_delivery_event(event)
            && matches_completion(event, session)
            && event["at"] == session.updated_at
    });
    let mut event = original.cloned().unwrap_or_else(|| {
        json!({
            "eventId": format!("delivery:{}:{}", session.session_id, session.updated_at),
            "kind": "report_available",
            "workspaceId": session.workspace_id,
            "sessionId": session.session_id,
            "at": session.updated_at,
            "payload": {
                "planId": session.plan_id,
                "status": "completed",
                "followUpEpoch": session.follow_up_epoch.unwrap_or(0)
            },
        })
    });
    event["payload"]["deliveryRevision"] = json!(session.updated_at);
    event
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider::{ReplyOrigin, TurnExecutionState, commit_composed_reply},
        test_model::{
            AutoAllowPermission, mock_model, spawn_autonomy_fixture, sse_text, sse_tool_call,
            start_mock_server,
        },
    };
    use peer_store::DirectoryLock;
    use std::time::Duration;

    #[tokio::test]
    async fn reports_survive_settlement_write_failure_and_reconcile_without_a_second_reply() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join("readme.md"), "fixture").unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host
            .bind_workspace(workspace.path(), Some("Settlement"))
            .unwrap();
        let ws = entry.workspace_id;
        let conv = profile.agent_conversation_id.unwrap();
        host.ensure_lease(&ws).unwrap();
        let child = spawn_autonomy_fixture(&host, &ws, &conv, workspace.path());
        host.supervisor.promote_queued(&ws, true).unwrap();
        let server = start_mock_server(vec![
            Box::new(|_| sse_tool_call("read", "read_file", &json!({"path": "readme.md"}))),
            Box::new(|_| sse_text("The README contains fixture.")),
        ]);
        host.run_promoted_session(
            &ws,
            &child.session_id,
            &mock_model(&server.endpoint),
            None,
            &mut AutoAllowPermission,
            5,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let result = host.supervisor.read_report(&ws, &child.session_id).unwrap();
        assert_eq!(result.verdict_outcome, "passed");
        let mut state = TurnExecutionState {
            workspace_id: ws.clone(),
            conversation_id: conv.clone(),
            turn_id: "settlement-write".into(),
            kind: "user".to_owned(),
            holds_lease: true,
            current_input_anchors: child.anchor_message_ids.clone(),
            valid_user_message_ids: child.anchor_message_ids.iter().cloned().collect(),
            read_result_revisions: [(child.session_id.clone(), result.summary.updated_at.clone())]
                .into(),
            ..Default::default()
        };
        let index_lock = DirectoryLock::acquire(
            &home.path().join("goal-plans/index.jsonl"),
            Duration::from_secs(1),
            None,
        )
        .unwrap();
        let reply = commit_composed_reply(
            &json!({"text": "The README contains fixture."}),
            home.path(),
            &host.supervisor,
            &mut state,
            "settlement-write",
            ReplyOrigin::Natural,
        )
        .map_err(|failure| failure.err)
        .unwrap();
        assert_eq!(reply["ok"], true);
        assert!(host.supervisor.read_plan(&child.plan_id).unwrap()["resultAcceptance"].is_null());
        let history = crate::read_full_conversation_messages(&host.conversations, &conv).unwrap();
        assert!(history.iter().any(|msg| reports_result_revision(
            msg,
            &child.session_id,
            &result.summary.updated_at
        )));
        drop(index_lock);

        assert!(
            host.reconcile_deliveries(&ws, &conv, 10, true, &[])
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            host.supervisor.read_plan(&child.plan_id).unwrap()["resultAcceptance"]["acceptedBy"],
            "policy"
        );
        let after = crate::read_full_conversation_messages(&host.conversations, &conv).unwrap();
        assert_eq!(after, history);
    }

    #[test]
    fn wake_retries_are_bounded_persist_across_reads_and_leave_inbox_free() {
        let home = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host
            .bind_workspace(workspace.path(), Some("Retries"))
            .unwrap();
        let ws = entry.workspace_id;
        let conv = profile.agent_conversation_id.unwrap();
        host.ensure_lease(&ws).unwrap();
        let plan = json!({
            "planId": "plan-pending", "conversationId": "child", "title": "Pending",
            "status": "completed", "updatedAt": "2026-11-26T00:00:00.000Z",
            "delegationOrigin": {"phase": "completed", "sessionId": "child",
                "parentConversationId": conv, "workspaceId": ws, "readOnly": true}
        });
        host.supervisor.save_plan_json(&plan).unwrap();
        let missing = AgentTurnOutcome {
            turn_id: "wake-placeholder".into(),
            end: TurnEndKind::Yielded,
            spawned_session_ids: Vec::new(),
            tool_calls: 16,
            failure_hold: None,
        };
        let now = 1_000;
        let attempts = host
            .reconcile_deliveries(&ws, &conv, now, true, &[])
            .unwrap();
        assert_eq!(attempts.len(), 1);
        host.inbox
            .append(
                &ws,
                &[json!({"eventId": "unrelated", "kind": "worker_question"})],
            )
            .unwrap();
        let batch = host.inbox.take_batch(&ws, now, true);
        host.finish_delivery_attempt(&ws, &attempts, now, &missing, Some(batch.through_seq))
            .unwrap();
        assert!(!host.inbox.has_pending(&ws));
        assert!(!host.has_due_delivery(&ws, now + 14_999));
        assert!(host.has_due_delivery(&ws, now + 15_000));

        let from_disk = ProjectInbox::new(home.path()).read_cursor_document(&ws);
        assert_eq!(from_disk.pending_deliveries["child"].attempts, 1);
        let held = AgentTurnOutcome {
            failure_hold: Some(FailureHoldSignal::AuthRejected),
            ..missing.clone()
        };
        host.finish_delivery_attempt(&ws, &attempts, now + 15_000, &held, None)
            .unwrap();
        assert_eq!(host.inbox.read_cursor_document(&ws), from_disk);
        host.finish_delivery_attempt(&ws, &attempts, now + 15_000, &missing, None)
            .unwrap();
        assert!(!host.has_due_delivery(&ws, now + 74_999));
        assert!(host.has_due_delivery(&ws, now + 75_000));
        host.finish_delivery_attempt(&ws, &attempts, now + 75_000, &missing, None)
            .unwrap();
        let exhausted = host
            .inbox
            .read_cursor_document(&ws)
            .pending_deliveries
            .remove("child")
            .unwrap();
        assert_eq!(exhausted.attempts, 3);
        assert_eq!(
            exhausted.last_error.as_deref(),
            Some("result_delivery_missing")
        );
        assert!(!host.has_due_delivery(&ws, i64::MAX));
        assert!(
            host.reconcile_deliveries(&ws, &conv, i64::MAX, true, &[])
                .unwrap()
                .is_empty()
        );
        let mut revised = plan;
        revised["updatedAt"] = json!("2026-11-26T00:01:00.000Z");
        host.supervisor.save_plan_json(&revised).unwrap();
        assert_eq!(
            host.reconcile_deliveries(&ws, &conv, now, true, &[])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            host.inbox.read_cursor_document(&ws).pending_deliveries["child"].attempts,
            0
        );
    }
}
