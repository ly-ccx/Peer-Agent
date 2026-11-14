//! Explicit synthetic fixture; never invoked by the native CLI.
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, EvidenceIndexStore,
    HostApproval, HostToolEvidence, NewConversation,
};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
fn main() {
    let root =
        PathBuf::from(std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    let mut input = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut input).unwrap();
    let v = peer_protocol::decode_json_bounded(
        &input,
        peer_protocol::JsonLimits {
            bytes: 1_048_576,
            nodes: 16384,
            depth: 64,
            string_bytes: 1_048_576,
        },
    )
    .unwrap()
    .value;
    let s = ConversationStore::new(&root);
    let a = ApprovalStore::new(&root);
    let id = v["id"].as_str().unwrap_or("");
    let workspace = v["workspaceId"].as_str();
    let at = v["at"].as_str().unwrap_or("2026-11-14T04:00:00.000Z");
    let result = (|| -> Result<Value, peer_store::StoreError> {
        Ok(match v["op"].as_str().unwrap_or("") {
            "create" => s.create(
                &NewConversation {
                    title: v["title"].as_str().unwrap_or("Fixture"),
                    workspace_path: v["workspacePath"].as_str(),
                    mode: "chat",
                    created_at: at,
                },
                None,
            )?,
            "history" => {
                let snap = s.read_committed(id, None, 8 * 1024 * 1024)?;
                json!({"history":snap.history,"source":snap.source_revision})
            }
            "commit" | "crash" | "interrupt" => {
                let mut snapshot = s.read_committed(id, None, 8 * 1024 * 1024)?;
                if let Some(rev) = v["revision"].as_u64() {
                    snapshot.history.content_revision = rev
                }
                if let Some(source) = v["source"].as_str() {
                    snapshot.source_revision = source.to_owned()
                }
                let result = if v["op"] == "commit" {
                    s.commit_message(&snapshot, &v["message"], at, None)
                } else {
                    s.commit_message_fixture(&snapshot, &v["message"], at, v["op"] == "crash")
                }?;
                json!({"history":result.snapshot.history,"alreadyCommitted":result.already_committed})
            }
            "reconcile" => json!({"history":s.reconcile_index(id,at,None)?.history}),
            "hold_approval" => {
                let file = root
                    .join("project-runtime")
                    .join(workspace.unwrap_or("_unscoped"))
                    .join("approvals.jsonl");
                let lock = peer_store::DirectoryLock::acquire(
                    &file,
                    std::time::Duration::from_millis(100),
                    None,
                )?;
                println!("{}", json!({"phase":"locked"}));
                io::stdout().flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(400));
                lock.release()?;
                Value::Null
            }
            "evidence_register" => json!(EvidenceIndexStore::new(&root).register(
                &HostToolEvidence {
                    conversation_id: "conversation",
                    plan_id: Some("plan"),
                    stream_id: Some("stream"),
                    tool_name: "write_file",
                    capability_id: "local.file.write",
                    tool_call_id: id,
                    grant: &v["grant"],
                    result: &v["result"],
                },
                None
            )?),
            "evidence_find" => {
                let refs: Vec<String> = v["refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| r.as_str().unwrap().to_owned())
                    .collect();
                json!(EvidenceIndexStore::new(&root).find(&refs, None)?)
            }
            "approval_list" => json!(a.list(workspace, None)?),
            "approval_open" => a.open(
                &HostApproval {
                    approval_id: id,
                    workspace_id: workspace,
                    conversation_id: "conversation",
                    stream_id: "stream",
                    plan_id: None,
                    session_id: None,
                    capability_id: "local.shell.exec",
                    args_digest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                    policy_revision: "3",
                    created_at: at,
                    deadline_at: v["deadlineAt"].as_str(),
                },
                None,
            )?,
            "approval_decide" => a.decide(
                &v["expected"],
                if v["allow"] == true {
                    ApprovalState::Approved
                } else {
                    ApprovalState::Denied
                },
                ApprovalDecision::LocalUser,
                at,
                None,
                None,
            )?,
            "approval_recover" => json!(a.recover_owned(workspace, at, None)?),
            _ => return Err(peer_store::StoreError::InvalidInput),
        })
    })();
    println!(
        "{}",
        match result {
            Ok(data) => json!({"ok":true,"data":data}),
            Err(e) => json!({"ok":false,"code":e.code()}),
        }
    );
}
