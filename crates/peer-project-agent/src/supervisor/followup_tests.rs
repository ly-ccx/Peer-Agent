use crate::{NativeProjectHost, test_model::*};
use peer_runtime::CancellationToken;
use serde_json::json;
use std::{fs, sync::Arc};
use tempfile::tempdir;

#[tokio::test]
async fn message_session_followup_reuses_checkpoint_and_increments_epoch() {
    use crate::MessageSessionRequest;
    for previous in ["result_ready", "accepted", "failed"] {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host.bind_workspace(ws.path(), Some("Follow Up")).unwrap();
        let ws_id = entry.workspace_id;
        let parent = profile.agent_conversation_id.unwrap();
        host.ensure_lease(&ws_id).unwrap();
        let child = spawn_autonomy_fixture(&host, &ws_id, &parent, ws.path());
        let supervisor = host.supervisor();
        supervisor.promote_queued(&ws_id, true).unwrap();
        let worker =
            start_mock_server(vec![
                Box::new(|_| sse_text("CHECKPOINT_FIRST_OUTPUT")),
                Box::new(|req| {
                    let messages = req["messages"].as_array().unwrap();
                    assert!(
                        messages.iter().any(|m| m["role"] == "assistant"
                            && m["content"] == "CHECKPOINT_FIRST_OUTPUT")
                    );
                    assert_eq!(
                        messages
                            .iter()
                            .filter(|m| m["role"] == "user"
                                && m["content"]
                                    .as_str()
                                    .is_some_and(|text| text.contains("Refine the last report.")))
                            .count(),
                        1,
                        "follow-up instruction should be delivered once without duplication"
                    );
                    assert!(messages.iter().any(|m| m["role"] == "user"
                        && m["content"].as_str().is_some_and(|text| {
                            text.contains("latest follow-up instruction recorded above")
                        })));
                    sse_text("CHECKPOINT_SECOND_OUTPUT")
                }),
            ]);
        let model = mock_model(&worker.endpoint);
        let cancel = CancellationToken::new();
        host.run_promoted_session(
            &ws_id,
            &child.session_id,
            &model,
            None,
            &mut AutoAllowPermission,
            8,
            &cancel,
        )
        .await
        .unwrap();
        let mut plan = supervisor.read_plan(&child.plan_id).unwrap();
        let worker_id = plan["delegationOrigin"]["workerConversationId"]
            .as_str()
            .unwrap()
            .to_owned();
        if previous == "failed" {
            plan["status"] = json!("failed");
            plan["runner"]["status"] = json!("failed");
            plan["delegationOrigin"]["phase"] = json!("failed");
        } else if previous == "accepted" {
            plan["resultAcceptance"] =
                json!({"acceptedAt": "2026-11-26T00:00:00Z", "acceptedBy": "policy"});
        }
        supervisor.save_plan_json(&plan).unwrap();
        let req = MessageSessionRequest {
            workspace_id: &ws_id,
            session_id: &child.session_id,
            text: "Refine the last report.",
            intent: "followup",
            expected_epoch: Some(0),
            anchor_message_ids: vec![],
            worker_model_selection: Some(
                json!({"providerName": "openai", "modelId": "mock-e2e-model"}),
            ),
            holds_lease: true,
        };
        let resumed = supervisor.message_session_full(req.clone()).unwrap();
        assert_eq!(resumed.delivery, "resumed_followup");
        assert_eq!(resumed.session_id, child.session_id);
        assert_eq!(resumed.conversation_id, worker_id);
        assert_eq!(resumed.follow_up_epoch, 1);
        assert_eq!(resumed.summary.status, "queued");
        assert_eq!(
            supervisor.message_session_full(req).unwrap_err().code,
            "follow_up_claimed"
        );
        let plan = supervisor.read_plan(&child.plan_id).unwrap();
        assert_eq!(
            plan["delegationOrigin"]["followUpHistory"][0]["previousStatus"],
            previous
        );
        assert_eq!(
            plan["delegationOrigin"]["followUpHistory"][0]["workerOutputPreview"],
            "CHECKPOINT_FIRST_OUTPUT"
        );
        assert!(plan["resultAcceptance"].is_null());
        supervisor.promote_queued(&ws_id, true).unwrap();
        host.run_promoted_session(
            &ws_id,
            &child.session_id,
            &model,
            None,
            &mut AutoAllowPermission,
            8,
            &cancel,
        )
        .await
        .unwrap();
        let plan = supervisor.read_plan(&child.plan_id).unwrap();
        assert_eq!(plan["delegationOrigin"]["workerConversationId"], worker_id);
        assert_eq!(
            plan["delegationOrigin"]["lastWorkerOutput"],
            "CHECKPOINT_SECOND_OUTPUT"
        );
        assert!(plan["delegationOrigin"]["followUpPrompt"].is_null());
        assert_eq!(worker.requests.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn message_session_followup_falls_back_to_started_fresh_on_model_change_or_missing_checkpoint()
 {
    use crate::MessageSessionRequest;
    for has_checkpoint in [true, false] {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host.bind_workspace(ws.path(), Some("Fresh")).unwrap();
        let ws_id = entry.workspace_id;
        let parent = profile.agent_conversation_id.unwrap();
        host.ensure_lease(&ws_id).unwrap();
        let child = spawn_autonomy_fixture(&host, &ws_id, &parent, ws.path());
        let supervisor = host.supervisor();
        if has_checkpoint {
            supervisor.promote_queued(&ws_id, true).unwrap();
            let worker =
                start_mock_server(vec![Box::new(|_| sse_text("Prior result for handoff."))]);
            host.run_promoted_session(
                &ws_id,
                &child.session_id,
                &mock_model(&worker.endpoint),
                None,
                &mut AutoAllowPermission,
                8,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        } else {
            supervisor
                .fail_session(
                    &ws_id,
                    &child.session_id,
                    "model_timeout",
                    "No checkpoint",
                    true,
                )
                .unwrap();
        }
        let req = MessageSessionRequest {
            workspace_id: &ws_id,
            session_id: &child.session_id,
            text: "Please revisit the result.",
            intent: "followup",
            expected_epoch: Some(0),
            anchor_message_ids: vec![],
            worker_model_selection: has_checkpoint
                .then(|| json!({"providerName":"openai","modelId":"other-model"})),
            holds_lease: true,
        };
        let fresh = supervisor.message_session_full(req.clone()).unwrap();
        assert_eq!(fresh.delivery, "started_fresh");
        assert_ne!(fresh.session_id, child.session_id);
        assert_eq!(
            fresh.predecessor_session_id.as_deref(),
            Some(child.session_id.as_str())
        );
        let next = supervisor.read_plan(&fresh.summary.plan_id).unwrap();
        assert_eq!(next["delegationOrigin"]["supersedes"], child.session_id);
        assert!(
            next["goal"]
                .as_str()
                .unwrap()
                .contains("Please revisit the result.")
        );
        if has_checkpoint {
            assert!(
                next["goal"]
                    .as_str()
                    .unwrap()
                    .contains("Prior result for handoff.")
            );
        }
        let err = supervisor.message_session_full(req).unwrap_err();
        assert_eq!(err.code, "session_superseded");
        assert!(err.detail.contains(&fresh.session_id));
    }
}

#[tokio::test]
async fn message_session_amend_steers_running_session() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Demonstration").unwrap();
    let host = Arc::new(NativeProjectHost::new(home.path(), "test", Some(1)).unwrap());
    let (entry, profile) = host.bind_workspace(ws.path(), Some("Steer")).unwrap();
    let ws_id = entry.workspace_id;
    let parent = profile.agent_conversation_id.unwrap();
    host.ensure_lease(&ws_id).unwrap();
    let child = spawn_autonomy_fixture(&host, &ws_id, &parent, ws.path());
    let supervisor = host.supervisor();
    supervisor.promote_queued(&ws_id, true).unwrap();
    let steer_workspace = ws_id.clone();
    let steer_session = child.session_id.clone();
    let steer_host = Arc::clone(&host);
    let server = start_mock_server(vec![
        Box::new(move |_| {
            let delivery = steer_host
                .supervisor()
                .message_session_full(crate::MessageSessionRequest {
                    workspace_id: &steer_workspace,
                    session_id: &steer_session,
                    text: "Focus on the document title.",
                    intent: "amend",
                    expected_epoch: Some(0),
                    anchor_message_ids: vec![],
                    worker_model_selection: None,
                    holds_lease: true,
                })
                .unwrap();
            assert_eq!(delivery.delivery, "steered");
            sse_tool_call("worker-read", "read_file", &json!({"path":"README.md"}))
        }),
        Box::new(|req| {
            let messages = req["messages"].as_array().unwrap();
            assert!(messages.iter().any(|m| m["role"] == "tool"));
            assert_eq!(messages.last().unwrap()["role"], "user");
            assert_eq!(
                messages.last().unwrap()["content"],
                "Focus on the document title."
            );
            sse_text("The title is Demonstration.")
        }),
    ]);
    host.run_promoted_session(
        &ws_id,
        &child.session_id,
        &mock_model(&server.endpoint),
        None,
        &mut AutoAllowPermission,
        8,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    let plan = supervisor.read_plan(&child.plan_id).unwrap();
    assert_eq!(plan["delegationOrigin"]["pendingSteerSeq"], 1);
    assert_eq!(
        plan["delegationOrigin"]["lastWorkerOutput"],
        "The title is Demonstration."
    );
    let conversation = plan["delegationOrigin"]["workerConversationId"]
        .as_str()
        .unwrap();
    let history = host
        .conversations()
        .read_committed(conversation, None, 1024 * 1024)
        .unwrap();
    assert_eq!(
        history
            .history
            .messages
            .iter()
            .filter(|m| m["kind"] == "user_correction" && m["steerSeq"] == 1)
            .count(),
        1
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn message_session_followup_rejects_stale_expected_epoch_and_cancelled_or_superseded() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("Admission")).unwrap();
    let ws_id = entry.workspace_id;
    host.ensure_lease(&ws_id).unwrap();
    let child = spawn_autonomy_fixture(
        &host,
        &ws_id,
        &profile.agent_conversation_id.unwrap(),
        ws.path(),
    );
    let supervisor = host.supervisor();
    let mut plan = supervisor.read_plan(&child.plan_id).unwrap();
    let request = crate::MessageSessionRequest {
        workspace_id: &ws_id,
        session_id: &child.session_id,
        text: "Follow up",
        intent: "followup",
        expected_epoch: Some(1),
        anchor_message_ids: vec![],
        worker_model_selection: None,
        holds_lease: true,
    };
    assert_eq!(
        supervisor
            .message_session_full(request.clone())
            .unwrap_err()
            .code,
        "follow_up_claimed"
    );
    plan["status"] = json!("cancelled");
    supervisor.save_plan_json(&plan).unwrap();
    assert_eq!(
        supervisor
            .message_session_full(request.clone())
            .unwrap_err()
            .code,
        "session_cancelled"
    );
    plan["delegationOrigin"]["supersededBy"] = json!("replacement");
    supervisor.save_plan_json(&plan).unwrap();
    let err = supervisor.message_session_full(request).unwrap_err();
    assert_eq!(err.code, "session_superseded");
    assert!(err.detail.contains("replacement"));
}
