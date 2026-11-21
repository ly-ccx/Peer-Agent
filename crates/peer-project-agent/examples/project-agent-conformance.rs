#![forbid(unsafe_code)]

use peer_project_agent::{
    CreateObjectiveRequest, DraftBody, DraftWriteRequest, MemoryFilter, NativeProjectHost,
    WriteMemoryRequest, bot_list_json,
};
use serde_json::json;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("Usage: project-agent-conformance <write|read> <data_home> <workspace_dir>");
        std::process::exit(2);
    }
    let mode = args[0].as_str();
    let data_home = PathBuf::from(&args[1]);
    let workspace = PathBuf::from(&args[2]);
    let host = NativeProjectHost::new(&data_home, "0.1.0-conformance", Some(2)).unwrap();

    match mode {
        "write" => {
            let (entry, profile) = host
                .bind_workspace(&workspace, Some("Interop Bot"))
                .unwrap();
            let ws_id = entry.workspace_id.clone();
            let conv_id = profile.agent_conversation_id.clone().unwrap();

            let input = host
                .submit_user_input(&ws_id, "interop-in-1", "Check Rust to TS interop", None)
                .unwrap();

            let draft_rev = host
                .drafts()
                .write(DraftWriteRequest {
                    workspace_id: &ws_id,
                    surface: "tui",
                    revision: 0,
                    draft: DraftBody {
                        text: "Draft text from Rust".into(),
                        ..Default::default()
                    },
                    pending: vec![],
                    uploads: vec![],
                })
                .unwrap();

            host.inbox()
                .append(
                    &ws_id,
                    &[json!({
                        "eventId": "ev-rust-1",
                        "kind": "session_spawned",
                        "sessionId": "sess-interop-1",
                        "payload": {"title": "Rust event"}
                    })],
                )
                .unwrap();

            let memory = host
                .memory()
                .write(&WriteMemoryRequest {
                    scope: "project",
                    workspace_id: Some(&ws_id),
                    kind: "decision",
                    text: "Rust 原生 CLI 跨语言 conformance 验证通过",
                    trust: "stated",
                    source_refs: vec!["in:interop-in-1".into()],
                    pinned: true,
                    anchor_message_id: Some("in:interop-in-1"),
                    expires_at: None,
                    topic_key: None,
                    topic_value: None,
                    file_anchors: None,
                })
                .unwrap();

            let (objective, _) = host
                .objectives()
                .create(&CreateObjectiveRequest {
                    workspace_id: &ws_id,
                    project_agent_conversation_id: &conv_id,
                    origin_message_id: "in:interop-in-1",
                    title: "Cross-language compatibility",
                    outcome: "TS and Rust read identical stores cleanly",
                    autonomy: "propose",
                    created_by: "user_request",
                    watches: vec![],
                    milestones: vec![],
                    success_signals: vec![],
                    budget: None,
                    deadline: None,
                    request_id: Some("req-obj-1"),
                })
                .unwrap();

            let out = json!({
                "workspaceId": ws_id,
                "conversationId": conv_id,
                "displayName": profile.display_name,
                "avatar": profile.avatar,
                "inputId": input.input_id,
                "draftRevision": draft_rev,
                "memoryId": memory.id,
                "objectiveId": objective.objective_id,
                "bots": bot_list_json(&host),
            });
            host.close();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        "read" => {
            let entry = host
                .registry()
                .find_by_path(&workspace.to_string_lossy())
                .unwrap()
                .expect("TS workspace found in Rust ProjectRegistry");
            let ws_id = entry.workspace_id.clone();
            let profile = host
                .profiles()
                .read(&ws_id)
                .expect("TS BotProfile found in Rust BotProfileStore");
            let inputs = host.inputs().list(&ws_id).unwrap();
            let draft = host.drafts().read(&ws_id, "tui", false).unwrap();
            let inbox = host.inbox().list_recent(&ws_id, 50);
            let memories = host.memory().list(&MemoryFilter {
                workspace_id: Some(&ws_id),
                ..Default::default()
            });
            let zh_hits = host.memory().search(Some(&ws_id), "原生", 10).unwrap();
            let en_hits = host
                .memory()
                .search(Some(&ws_id), "conformance", 10)
                .unwrap();
            let objectives = host.objectives().list(&ws_id).unwrap();
            let out = json!({
                "workspaceId": ws_id,
                "displayName": profile.display_name,
                "conversationId": profile.agent_conversation_id,
                "pendingInputIds": inputs.iter().map(|i| &i.input_id).collect::<Vec<_>>(),
                "draftText": draft.draft.text,
                "inboxEventIds": inbox.iter().filter_map(|e| e["eventId"].as_str()).collect::<Vec<_>>(),
                "memoryCount": memories.len(),
                "zhHits": zh_hits.len(),
                "enHits": en_hits.len(),
                "objectiveTitles": objectives.iter().map(|o| &o.title).collect::<Vec<_>>(),
                "bots": bot_list_json(&host),
            });
            host.close();
            println!("{}", serde_json::to_string(&out).unwrap());
        }
        other => {
            eprintln!("Unknown mode: {other}");
            std::process::exit(2);
        }
    }
}
