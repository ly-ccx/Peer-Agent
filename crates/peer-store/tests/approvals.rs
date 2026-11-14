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
