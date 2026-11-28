use peer_store::{ApprovalDecision, ApprovalState, ApprovalStore, HostApproval, StoreError};
use serde_json::{Value, json};
use std::{fs, sync::atomic::AtomicBool};
const AT: &str = "2026-11-14T04:00:00.000Z";
fn request(id: &str) -> HostApproval<'_> {
    HostApproval {
        approval_id: id,
        workspace_id: Some("workspace"),
        conversation_id: "conversation",
        stream_id: "stream",
        plan_id: None,
        session_id: None,
        capability_id: "local.shell.exec",
        args_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        policy_revision: "3",
        created_at: AT,
        deadline_at: None,
    }
}
#[test]
fn decisions_are_exact_cas_and_history_is_not_a_grant() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    assert!(s.list(Some("workspace"), None).unwrap().is_empty());
    assert!(!root.path().join("project-runtime").exists());
    let row = s.open(&request("call"), None).unwrap();
    assert_eq!(s.open(&request("call"), None).unwrap(), row);
    let yes = s
        .decide(
            &row,
            ApprovalState::Approved,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None,
        )
        .unwrap();
    assert_eq!(s.list(Some("workspace"), None).unwrap(), vec![yes.clone()]);
    assert_eq!(
        s.decide(
            &row,
            ApprovalState::Denied,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None
        )
        .unwrap_err(),
        StoreError::ApprovalConflict
    );
    assert_eq!(
        s.open(&request("call"), None).unwrap_err(),
        StoreError::ApprovalConflict
    );
    assert_eq!(
        s.decide(
            &yes,
            ApprovalState::Approved,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None
        )
        .unwrap_err(),
        StoreError::ApprovalConflict
    );
    let mut other = request("next");
    other.policy_revision = "4";
    let next = s.open(&other, None).unwrap();
    assert_eq!(next["policyRevision"], "4");
}
#[test]
fn recovery_is_workspace_scoped_expiry_and_stale_never_approve() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let a = s.open(&request("a"), None).unwrap();
    let mut exp = request("b");
    exp.deadline_at = Some(AT);
    s.open(&exp, None).unwrap();
    let mut other = request("other");
    other.workspace_id = Some("foreign");
    s.open(&other, None).unwrap();
    let changed = s.recover_owned(Some("workspace"), AT, None).unwrap();
    assert_eq!(changed[0]["state"], "stale");
    assert_eq!(changed[1]["state"], "expired");
    assert!(
        s.recover_owned(Some("workspace"), AT, None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(s.list(Some("foreign"), None).unwrap()[0]["state"], "open");
    assert_eq!(
        s.decide(
            &a,
            ApprovalState::Approved,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None
        )
        .unwrap_err(),
        StoreError::ApprovalConflict
    );
    s.open(&request("later"), None).unwrap();
}
#[test]
fn corrupt_partial_unknown_or_oversized_history_is_not_empty() {
    for bytes in [
        b"{bad}\n".as_slice(),
        b"{}\n",
        b"{\"approvalId\":\"x\"}",
        b"[]\n",
    ] {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("project-runtime/workspace");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("approvals.jsonl");
        fs::write(&file, bytes).unwrap();
        let s = ApprovalStore::new(root.path());
        assert!(s.list(Some("workspace"), None).is_err());
        assert!(s.open(&request("new"), None).is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let row = s.open(&request("x"), None).unwrap();
    let mut bad = row;
    bad["state"] = json!("unknown");
    let file = root
        .path()
        .join("project-runtime/workspace/approvals.jsonl");
    fs::write(&file, format!("{bad}\n")).unwrap();
    assert_eq!(
        s.list(Some("workspace"), None).unwrap_err(),
        StoreError::ApprovalCorrupt
    );
    fs::write(&file, vec![b' '; 8 * 1024 * 1024 + 1]).unwrap();
    assert_eq!(
        s.list(Some("workspace"), None).unwrap_err(),
        StoreError::HistoryLimit
    );
}
#[test]
fn unknown_fields_preserved_and_changes_bind_complete_record() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let mut row = s.open(&request("x"), None).unwrap();
    row["future"] = json!({"opaque":"evidence"});
    let file = root
        .path()
        .join("project-runtime/workspace/approvals.jsonl");
    fs::write(&file, format!("{row}\n")).unwrap();
    let stored = s.list(Some("workspace"), None).unwrap().remove(0);
    let no = s
        .decide(
            &stored,
            ApprovalState::Denied,
            ApprovalDecision::LocalUser,
            AT,
            Some("local_user_denied"),
            None,
        )
        .unwrap();
    assert_eq!(no["future"], row["future"]);
    let mut tampered: Value = stored;
    tampered["argsDigest"] = json!("f".repeat(64));
    assert!(
        s.decide(
            &tampered,
            ApprovalState::Approved,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None
        )
        .is_err()
    );
}
fn image_scope() -> Value {
    json!({"capabilityId": "local.image.read", "action": "read_image_for_model",
        "path": std::env::temp_dir().join("shot.png"), "workspacePath": null,
        "fileIdentity": {"dev": 1, "ino": 2, "size": 123, "mtimeMs": 4.125, "ctimeMs": 5.125}})
}

fn seed_image(root: &std::path::Path, state: &str, scope: Value) -> (Value, Value) {
    let store = ApprovalStore::new(root);
    let other = store.open(&request("other"), None).unwrap();
    let mut image = store.open(&request("image"), None).unwrap();
    image["state"] = json!(state);
    image["capabilityId"] = json!("local.image.read");
    if !scope.is_null() {
        image["imageReadScope"] = scope;
    }
    fs::write(
        root.join("project-runtime/workspace/approvals.jsonl"),
        format!("{other}\n{image}\n"),
    )
    .unwrap();
    (image, other)
}

#[test]
fn stale_image_grant_is_exact_cas_and_never_renewed_by_replay() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let scope = image_scope();
    let (image, other) = seed_image(root.path(), "stale", scope.clone());
    let mut tampered = image.clone();
    tampered["imageReadScope"]["fileIdentity"]["ino"] = json!(99);
    assert_eq!(
        s.decide_stale_image_read(&tampered, ApprovalState::Approved, AT, Some("conversation"))
            .unwrap_err(),
        StoreError::ApprovalConflict
    );
    let decided = s
        .decide_stale_image_read(&image, ApprovalState::Approved, AT, Some("conversation"))
        .unwrap();
    assert_eq!(decided["state"], "approved");
    assert_eq!(decided["approvalId"], "image");
    assert!(decided.get("imageReadGrant").is_none());
    assert_eq!(
        s.decide_stale_image_read(&image, ApprovalState::Approved, AT, Some("conversation"))
            .unwrap_err(),
        StoreError::ApprovalConflict
    );
    let rows = s.list(Some("workspace"), None).unwrap();
    assert_eq!(rows.len(), 3);
    assert!(rows.contains(&other));
    let row = rows
        .iter()
        .find(|r| r["kind"] == "image_read_grant")
        .unwrap();
    let id = row["approvalId"].as_str().unwrap();
    assert!(id.starts_with("image-"));
    assert_eq!(row["state"], "approved");
    assert_eq!(row["decidedAt"], AT);
    assert_eq!(row["decidedBy"], "local_ui");
    assert_eq!(
        row["imageReadGrant"],
        json!({"schemaVersion": 1, "grantId": id,
        "workspaceId": "workspace", "conversationId": "conversation", "policyRevision": "3",
        "expiresAt": 1_794_630_600_000_i64, "scope": scope})
    );
}

#[test]
fn invalid_stale_image_scope_cannot_grant_but_can_be_denied() {
    for bad in [
        Value::Null,
        json!({"path": "/shot.png"}),
        {
            let mut scope = image_scope();
            scope["path"] = json!("relative.png");
            scope
        },
        {
            let mut scope = image_scope();
            scope["fileIdentity"]["ctimeMs"] = json!("5");
            scope
        },
    ] {
        let root = tempfile::tempdir().unwrap();
        let s = ApprovalStore::new(root.path());
        let (image, other) = seed_image(root.path(), "stale", bad);
        assert_eq!(
            s.decide_stale_image_read(&image, ApprovalState::Approved, AT, Some("conversation"))
                .unwrap_err(),
            StoreError::InvalidInput
        );
        let denied = s
            .decide_stale_image_read(&image, ApprovalState::Denied, AT, None)
            .unwrap();
        assert_eq!(denied["decisionReason"], "local_user_denied");
        assert_eq!(
            s.list(Some("workspace"), None).unwrap(),
            vec![denied, other]
        );
    }
}

#[test]
fn live_image_grant_requires_a_settled_approval_and_reuses_unexpired_scope() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let (image, other) = seed_image(root.path(), "open", image_scope());
    assert_eq!(
        s.remember_live_image_read(&image, &image, "conversation")
            .unwrap_err(),
        StoreError::ApprovalConflict
    );
    let approved = s
        .decide(
            &image,
            ApprovalState::Approved,
            ApprovalDecision::LocalUser,
            AT,
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        s.list(Some("workspace"), None).unwrap(),
        vec![approved.clone(), other]
    );
    s.remember_live_image_read(&image, &approved, "conversation")
        .unwrap();
    let rows = s.list(Some("workspace"), None).unwrap();
    assert_eq!(
        rows.iter()
            .filter(|row| row.get("imageReadGrant").is_some())
            .count(),
        1
    );
    s.remember_live_image_read(&image, &approved, "conversation")
        .unwrap();
    assert_eq!(s.list(Some("workspace"), None).unwrap(), rows);
}

#[test]
fn cancellation_orphan_lock_and_symlink_preserve_facts() {
    let root = tempfile::tempdir().unwrap();
    let s = ApprovalStore::new(root.path());
    let flag = AtomicBool::new(true);
    assert_eq!(
        s.open(&request("x"), Some(&flag)).unwrap_err(),
        StoreError::Cancelled
    );
    s.open(&request("x"), None).unwrap();
    let dir = root.path().join("project-runtime/workspace");
    let file = dir.join("approvals.jsonl");
    let before = fs::read(&file).unwrap();
    fs::create_dir(dir.join("approvals.jsonl.lock")).unwrap();
    assert_eq!(
        s.open(&request("y"), None).unwrap_err(),
        StoreError::LockBusy
    );
    assert!(dir.join("approvals.jsonl.lock").exists());
    assert_eq!(fs::read(&file).unwrap(), before);
    fs::remove_dir(dir.join("approvals.jsonl.lock")).unwrap();
    let target = root.path().join("target");
    fs::rename(&file, &target).unwrap();
    std::os::unix::fs::symlink(&target, &file).unwrap();
    assert!(s.open(&request("y"), None).is_err());
    assert_eq!(fs::read(target).unwrap(), before);
}
