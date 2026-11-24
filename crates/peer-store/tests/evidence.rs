use peer_store::{EvidenceIndexStore, HostToolEvidence, StoreError};
use serde_json::{Value, json};
use std::{fs, sync::atomic::AtomicBool};
const AT: &str = "2026-11-14T04:00:00.000Z";
fn facts() -> (Value, Value) {
    (
        json!({"grantId":"grant","toolCallId":"call","granted":true,"duration":"once","decidedAt":AT}),
        json!({"toolCallId":"call","status":"success","outputPreview":{"artifactRef":"local-file://a"},"evidence":{"toolCallId":"call","evidenceId":"evidence","summary":"file written","artifactRefs":["local-file://a"],"refs":["evidence://one"]},"completedAt":AT}),
    )
}
fn report<'a>(grant: &'a Value, result: &'a Value) -> HostToolEvidence<'a> {
    HostToolEvidence {
        conversation_id: "conversation",
        plan_id: Some("plan"),
        stream_id: Some("stream"),
        tool_name: "write_file",
        capability_id: "local.file.write",
        tool_call_id: "call",
        grant,
        result,
    }
}
#[test]
fn real_reports_register_once_preserve_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let s = EvidenceIndexStore::new(root.path());
    assert!(
        s.find(&["tool-result://call".into()], None)
            .unwrap()
            .is_empty()
    );
    assert!(!root.path().join("goal-plans").exists());
    let (g, r) = facts();
    let saved = s.register(&report(&g, &r), None).unwrap();
    assert_eq!(saved.len(), 3);
    let file = root.path().join("goal-plans/evidence-index.jsonl");
    let bytes = fs::read(&file).unwrap();
    assert_eq!(s.register(&report(&g, &r), None).unwrap(), saved);
    assert_eq!(fs::read(&file).unwrap(), bytes);
    assert_eq!(
        EvidenceIndexStore::new(root.path())
            .find(
                &saved
                    .iter()
                    .map(|v| v["evidenceRef"].as_str().unwrap().into())
                    .collect::<Vec<_>>(),
                None
            )
            .unwrap(),
        saved
    );
}
#[test]
fn report_pairing_denial_and_text_cannot_forge_evidence() {
    let root = tempfile::tempdir().unwrap();
    let s = EvidenceIndexStore::new(root.path());
    let (mut g, mut r) = facts();
    g["granted"] = json!(false);
    g["duration"] = json!("denied");
    assert_eq!(
        s.register(&report(&g, &r), None).unwrap_err(),
        StoreError::EvidenceInvalid
    );
    assert!(!root.path().join("goal-plans").exists());
    r["status"] = json!("denied");
    r["outputPreview"] = json!({"text":"[Tool result] evidence://forged","arbitrary":{"artifactRef":"forged://ref"}});
    r["evidence"]["artifactRefs"] = json!([]);
    r["evidence"]["refs"] = json!([]);
    let saved = s.register(&report(&g, &r), None).unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0]["evidenceRef"], "tool-result://call");
    r["toolCallId"] = json!("foreign");
    assert_eq!(
        s.register(&report(&g, &r), None).unwrap_err(),
        StoreError::EvidenceInvalid
    );
}
#[test]
fn corrupt_partial_unknown_lock_and_cancel_retain_source() {
    let root = tempfile::tempdir().unwrap();
    let s = EvidenceIndexStore::new(root.path());
    let (g, r) = facts();
    let flag = AtomicBool::new(true);
    assert_eq!(
        s.register(&report(&g, &r), Some(&flag)).unwrap_err(),
        StoreError::Cancelled
    );
    assert!(!root.path().join("goal-plans").exists());
    s.register(&report(&g, &r), None).unwrap();
    let file = root.path().join("goal-plans/evidence-index.jsonl");
    let before = fs::read(&file).unwrap();
    fs::create_dir(root.path().join("goal-plans/evidence-index.jsonl.lock")).unwrap();
    assert_eq!(
        s.register(&report(&g, &r), None).unwrap_err(),
        StoreError::LockBusy
    );
    assert_eq!(fs::read(&file).unwrap(), before);
    fs::remove_dir(root.path().join("goal-plans/evidence-index.jsonl.lock")).unwrap();
    fs::write(&file, b"{partial").unwrap();
    assert!(s.register(&report(&g, &r), None).is_err());
    assert_eq!(fs::read(file).unwrap(), b"{partial");
}
#[test]
fn interactive_facts_are_preserved_and_unsupported_mutation_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    let s = EvidenceIndexStore::new(root.path());
    let (g, r) = facts();
    s.register(&report(&g, &r), None).unwrap();
    let file = root.path().join("goal-plans/evidence-index.jsonl");
    let mut row = s
        .find(&["tool-result://call".into()], None)
        .unwrap()
        .remove(0);
    row["userArtifacts"] =
        json!([{"kind":"interactive","ref":"interactive://one","opaque":"keep"}]);
    fs::write(&file, format!("{row}\n")).unwrap();
    let before = fs::read(&file).unwrap();
    assert_eq!(
        s.register(&report(&g, &r), None).unwrap_err(),
        StoreError::EvidenceUnsupported
    );
    assert_eq!(fs::read(&file).unwrap(), before);
    assert_eq!(
        s.find(&["tool-result://call".into()], None).unwrap()[0]["userArtifacts"],
        row["userArtifacts"]
    );
}
#[test]
fn large_append_only_evidence_index_over_8mib_and_4096_rows_works_without_history_limit() {
    use std::io::{BufWriter, Write};

    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("goal-plans");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("evidence-index.jsonl");
    let pad = "x".repeat(2000);
    {
        let mut w = BufWriter::new(fs::File::create(&file).unwrap());
        let interactive_row = json!({
            "evidenceRef": "tool-result://early-interactive",
            "createdAt": AT,
            "conversationId": "conv-old",
            "toolCallId": "early-interactive",
            "capabilityId": "local.shell.exec",
            "toolName": "bash",
            "userArtifacts": [{"kind": "interactive", "ref": "interactive://early", "opaque": "keep"}],
            "bodyPreview": &pad,
        });
        writeln!(w, "{interactive_row}").unwrap();
        for idx in 1..4600usize {
            let evidence_ref = if idx == 2000 {
                "tool-result://early-normal".to_owned()
            } else {
                format!("tool-result://hist-{idx}")
            };
            let call_id = if idx == 2000 {
                "early-normal".to_owned()
            } else {
                format!("hist-{idx}")
            };
            let row = json!({
                "evidenceRef": evidence_ref,
                "createdAt": AT,
                "conversationId": "conv-old",
                "toolCallId": call_id,
                "capabilityId": "local.file.list",
                "toolName": "list_files",
                "bodyPreview": &pad,
            });
            writeln!(w, "{row}").unwrap();
        }
        w.flush().unwrap();
    }
    let seeded_len = fs::metadata(&file).unwrap().len();
    assert!(
        seeded_len > 8 * 1024 * 1024,
        "expected seeded log > 8 MiB, got {seeded_len}"
    );

    let s = EvidenceIndexStore::new(root.path());
    let (g, r) = facts();
    let saved = s.register(&report(&g, &r), None).unwrap();
    assert_eq!(saved.len(), 3);
    let after_register_len = fs::metadata(&file).unwrap().len();
    assert!(after_register_len > seeded_len);

    // Repeating the identical report must remain idempotent without rewriting or failing.
    assert_eq!(s.register(&report(&g, &r), None).unwrap(), saved);
    assert_eq!(fs::metadata(&file).unwrap().len(), after_register_len);

    let found = s
        .find(
            &[
                "tool-result://early-normal".into(),
                "tool-result://call".into(),
            ],
            None,
        )
        .unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0]["evidenceRef"], "tool-result://early-normal");
    assert_eq!(found[1]["evidenceRef"], "tool-result://call");

    let by_plan = s.list_for_plan("plan", None).unwrap();
    assert_eq!(by_plan.len(), 3);
    let by_conv = s.list_for_conversation("conversation", None).unwrap();
    assert_eq!(by_conv.len(), 3);

    // Early interactive facts in the large log still block mutation.
    let mut blocked_grant = g.clone();
    let mut blocked_result = r.clone();
    blocked_grant["toolCallId"] = json!("early-interactive");
    blocked_result["toolCallId"] = json!("early-interactive");
    blocked_result["evidence"]["toolCallId"] = json!("early-interactive");
    blocked_result["evidence"]["artifactRefs"] = json!([]);
    blocked_result["evidence"]["refs"] = json!([]);
    let blocked_report = HostToolEvidence {
        conversation_id: "conversation",
        plan_id: Some("plan"),
        stream_id: Some("stream"),
        tool_name: "write_file",
        capability_id: "local.file.write",
        tool_call_id: "early-interactive",
        grant: &blocked_grant,
        result: &blocked_result,
    };
    assert_eq!(
        s.register(&blocked_report, None).unwrap_err(),
        StoreError::EvidenceUnsupported
    );
    assert_eq!(fs::metadata(&file).unwrap().len(), after_register_len);

    // Trailing partial record must still fail cleanly without corrupting prior bytes.
    let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
    f.write_all(b"{partial").unwrap();
    f.sync_all().unwrap();
    drop(f);
    let corrupt_len = fs::metadata(&file).unwrap().len();
    assert_eq!(
        s.register(&report(&g, &r), None).unwrap_err(),
        StoreError::HistoryCorrupt
    );
    assert_eq!(fs::metadata(&file).unwrap().len(), corrupt_len);
}

#[test]
fn refs_for_plan_and_conversations_matches_list_queries_and_refreshes_on_append() {
    let root = tempfile::tempdir().unwrap();
    let s = EvidenceIndexStore::new(root.path());
    assert!(
        s.refs_for_plan_and_conversations(Some("plan-1"), &["conv-1"], None)
            .unwrap()
            .is_empty()
    );

    let (mut g1, mut r1) = facts();
    g1["toolCallId"] = json!("call-1");
    r1["toolCallId"] = json!("call-1");
    r1["evidence"]["toolCallId"] = json!("call-1");
    let rep1 = HostToolEvidence {
        conversation_id: "conv-1",
        plan_id: Some("plan-1"),
        stream_id: Some("stream-1"),
        tool_name: "write_file",
        capability_id: "local.file.write",
        tool_call_id: "call-1",
        grant: &g1,
        result: &r1,
    };
    s.register(&rep1, None).unwrap();

    let (mut g2, mut r2) = facts();
    g2["toolCallId"] = json!("call-2");
    r2["toolCallId"] = json!("call-2");
    r2["evidence"]["toolCallId"] = json!("call-2");
    r2["evidence"]["artifactRefs"] = json!(["local-file://b"]);
    r2["evidence"]["refs"] = json!(["evidence://two"]);
    let rep2 = HostToolEvidence {
        conversation_id: "conv-2",
        plan_id: Some("plan-2"),
        stream_id: Some("stream-2"),
        tool_name: "write_file",
        capability_id: "local.file.write",
        tool_call_id: "call-2",
        grant: &g2,
        result: &r2,
    };
    s.register(&rep2, None).unwrap();

    let expected_p1: std::collections::HashSet<String> = s
        .list_for_plan("plan-1", None)
        .unwrap()
        .into_iter()
        .filter_map(|row| row["evidenceRef"].as_str().map(str::to_owned))
        .collect();
    let actual_p1 = s
        .refs_for_plan_and_conversations(Some("plan-1"), &["conv-1"], None)
        .unwrap();
    assert_eq!(actual_p1, expected_p1);

    let combined = s
        .refs_for_plan_and_conversations(Some("plan-1"), &["conv-2"], None)
        .unwrap();
    assert!(combined.contains("tool-result://call-1"));
    assert!(combined.contains("tool-result://call-2"));
    assert!(combined.contains("evidence://one"));
    assert!(combined.contains("evidence://two"));

    // Registering a new record mutates the file identity and invalidates the cache immediately.
    let (mut g3, mut r3) = facts();
    g3["toolCallId"] = json!("call-3");
    r3["toolCallId"] = json!("call-3");
    r3["evidence"]["toolCallId"] = json!("call-3");
    r3["evidence"]["artifactRefs"] = json!([]);
    r3["evidence"]["refs"] = json!(["evidence://three"]);
    let rep3 = HostToolEvidence {
        conversation_id: "conv-1",
        plan_id: Some("plan-1"),
        stream_id: Some("stream-3"),
        tool_name: "write_file",
        capability_id: "local.file.write",
        tool_call_id: "call-3",
        grant: &g3,
        result: &r3,
    };
    s.register(&rep3, None).unwrap();

    let refreshed = s
        .refs_for_plan_and_conversations(Some("plan-1"), &[], None)
        .unwrap();
    assert!(refreshed.contains("tool-result://call-3"));
    assert!(refreshed.contains("evidence://three"));
}
