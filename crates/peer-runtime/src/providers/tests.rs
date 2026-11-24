use super::*;
const NOW: &str = "2026-11-17T00:00:00.000Z";

#[tokio::test]
async fn correlation_facts_without_host_admission_cannot_start_any_local_effect() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("input.txt"), "owned source").unwrap();
    let mut registry = ProviderRegistry::default();
    let projection = registry.project().unwrap();
    for (tool, args) in [
        ("read_file", json!({"path":"input.txt"})),
        ("list_files", json!({"path":"."})),
        ("search_files", json!({"path":".","query":"source"})),
        (
            "write_file",
            json!({"path":"never-file.txt","content":"forbidden"}),
        ),
        (
            "batch_search",
            json!({"queries":[{"query":"source","path":"."}]}),
        ),
        ("git_query", json!({"path":"."})),
        ("web_fetch", json!({"url":"http://127.0.0.1:9"})),
        (
            "bash",
            json!({"command":"printf forbidden > never-shell.txt"}),
        ),
        (
            "read_tool_result",
            json!({"reference":{"schemaVersion":1,"conversationId":"c","sha256":"a".repeat(64),"bytes":1,"format":"utf8"}}),
        ),
    ] {
        let effect = registry
            .prepare(&projection, tool, args, root.path(), root.path())
            .unwrap_or_else(|e| panic!("{tool}: {e}"));
        let result = effect.start(
            ProviderCall::new("c", "call", NOW),
            CancellationToken::new(),
        );
        assert!(
            matches!(result, Err(HostError("execution_admission_closed"))),
            "{tool} started without its actual Host port"
        );
    }
    assert!(!root.path().join("never-file.txt").exists());
    assert!(!root.path().join("never-shell.txt").exists());
    assert!(!root.path().join("shell-artifacts").exists());
    assert!(!root.path().join("web-artifacts").exists());
    assert!(!root.path().join("conversations").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn a_bound_rejected_shell_request_creates_neither_a_process_nor_startup_artifacts() {
    let root = tempfile::tempdir().unwrap();
    let mut registry = ProviderRegistry::default();
    let projection = registry.project().unwrap();
    let mut effect = registry
        .prepare(
            &projection,
            "bash",
            json!({"command":"printf forbidden > never.txt"}),
            root.path(),
            root.path(),
        )
        .unwrap();
    let token = CancellationToken::new();
    let (port, mut receiver) = EffectAdmission::channel(&token);
    effect.admission(port);
    let future = effect
        .start(ProviderCall::new("c", "call", NOW), token)
        .unwrap();
    let reject = async move {
        let Some(crate::effect_admission::AdmissionRequest::Check(reply)) = receiver.recv().await
        else {
            panic!("missing actual admission request")
        };
        reply
            .send(Err(HostError("permission_policy_changed")))
            .unwrap();
    };
    let (outcome, _) = tokio::join!(future, reject);
    assert_eq!(outcome.error, Some("permission_policy_changed"));
    assert!(outcome.ended);
    assert!(!root.path().join("never.txt").exists());
    assert!(!root.path().join("shell-artifacts").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn missing_nested_parent_read_list_search_and_edit_return_recoverable_tool_failures() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("existing.txt"), "hello\n").unwrap();
    let mut registry = ProviderRegistry::default();
    let projection = registry.project().unwrap();

    for (tool, args, expected_error) in [
        (
            "read_file",
            json!({"path": "missing_dir/deep/file.txt"}),
            "file_unavailable",
        ),
        (
            "list_files",
            json!({"path": "missing_dir/deep/shell-artifacts"}),
            "file_unavailable",
        ),
        (
            "search_files",
            json!({"path": "missing_dir/deep", "query": "hello"}),
            "file_unavailable",
        ),
        (
            "read_file",
            json!({"path": "existing.txt/child.txt"}),
            "file_unavailable",
        ),
        (
            "list_files",
            json!({"path": "existing.txt/child"}),
            "file_unavailable",
        ),
        (
            "edit_file",
            json!({"path": "missing_dir/deep/file.txt", "old_string": "a", "new_string": "b"}),
            "file_not_found",
        ),
    ] {
        let mut effect = registry
            .prepare(&projection, tool, args, root.path(), root.path())
            .unwrap_or_else(|e| panic!("{tool} prepare should not fatally abort: {e}"));
        let token = CancellationToken::new();
        let (port, mut receiver) = EffectAdmission::channel(&token);
        effect.admission(port);
        let future = effect
            .start(ProviderCall::new("c", "call", NOW), token)
            .unwrap();
        let allow = async move {
            while let Some(request) = receiver.recv().await {
                match request {
                    crate::effect_admission::AdmissionRequest::Check(reply) => {
                        let _ = reply.send(Ok(()));
                    }
                    crate::effect_admission::AdmissionRequest::ReadScope { reply, .. } => {
                        let _ = reply.send(Ok(()));
                    }
                    _ => panic!("unexpected admission request"),
                }
            }
        };
        let (outcome, _) = tokio::join!(future, allow);
        assert_eq!(
            outcome.status, "failed",
            "{tool} should settle as failed tool outcome"
        );
        assert_eq!(
            outcome.error,
            Some(expected_error),
            "{tool} unexpected error"
        );
        assert!(outcome.ended);
    }
    assert!(
        !root.path().join("missing_dir").exists(),
        "failed read/list/search/edit must never create missing directories"
    );
}
