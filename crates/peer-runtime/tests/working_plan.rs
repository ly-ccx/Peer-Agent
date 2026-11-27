use peer_protocol::{LocalAccessLevel, WORKING_PLAN_CAPABILITY, WorkingPlanInput};
use peer_runtime::{
    CancellationToken,
    conversation_host::{
        ConversationAccess, ConversationOptions, ConversationOutcome, DelegatedTaskContract,
        NativeConversationRuntime,
    },
    model::{
        ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
    providers::RuntimeMode,
    session_host::{LocalPermissionDecision, PermissionInput},
};
use peer_store::{ConversationStore, NewConversation, WorkingPlanStore};
use serde_json::{Value, json};
use std::{future::Future, path::Path, pin::Pin, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    task::JoinHandle,
};

const AT: &str = "2026-11-27T00:00:00Z";
const GUARD: &str = "[Host completion check";
const INVARIANT: &str = "Preserve the task boundary";
const CHECK: &str = "Inspect the proof file";

enum Reply {
    Text(&'static str),
    Call(&'static str, Value),
    Overflow,
}

impl Reply {
    fn http(self, index: usize) -> String {
        if matches!(self, Self::Overflow) {
            let body = json!({"error": {"code": "context_length_exceeded", "message": "Maximum context length exceeded"}}).to_string();
            return format!(
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
        let mut chunks = match self {
            Self::Text(content) => {
                vec![
                    json!({"choices":[{"index":0,"delta":{"content":content},"finish_reason":"stop"}]}),
                ]
            }
            Self::Call(name, args) => vec![
                json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":format!("call-{index}"),"type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":null}]}),
                json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
            ],
            Self::Overflow => unreachable!(),
        };
        chunks.push(json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}));
        let mut body = chunks
            .iter()
            .map(|chunk| format!("data: {chunk}\n\n"))
            .collect::<String>();
        body.push_str("data: [DONE]\n\n");
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }
}

async fn model(replies: Vec<Reply>) -> (NativeModel, JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut requests = Vec::new();
            for (index, reply) in replies.into_iter().enumerate() {
                let (stream, _) = listener.accept().await.unwrap();
                let mut stream = BufReader::new(stream);
                let mut size = None;
                loop {
                    let mut line = String::new();
                    assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        size = Some(value.trim().parse::<usize>().unwrap());
                    }
                }
                let mut body = vec![0; size.unwrap()];
                stream.read_exact(&mut body).await.unwrap();
                requests.push(serde_json::from_slice(&body).unwrap());
                stream
                    .write_all(reply.http(index).as_bytes())
                    .await
                    .unwrap();
                stream.shutdown().await.unwrap();
            }
            requests
        })
        .await
        .unwrap()
    });
    let model = NativeModel::new(
        ModelConfig {
            endpoint,
            model: "working-plan-fixture".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(5),
    )
    .unwrap();
    (model, server)
}

#[derive(Default)]
struct CountPermission(usize);

impl PermissionInput for CountPermission {
    fn decide<'a>(
        &'a mut self,
        _: Value,
        _: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        self.0 += 1;
        Box::pin(async { LocalPermissionDecision::Deny })
    }
}

struct Episode {
    outcome: ConversationOutcome,
    requests: Vec<Value>,
    history: String,
    approval_prompts: usize,
}

#[derive(Clone, Copy)]
enum Surface {
    Worker,
    Verifier,
    Foreground,
}

async fn episode(
    root: &Path,
    surface: Surface,
    mode: RuntimeMode,
    conversation: Option<&str>,
    max_turns: usize,
    replies: Vec<Reply>,
) -> Episode {
    let (model, server) = model(replies).await;
    let runtime = NativeConversationRuntime::new(
        root,
        ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
    )
    .with_delegated_contract(DelegatedTaskContract {
        title: "Task contract for working plan tests".into(),
        goal: "Exercise the real conversation host".into(),
        ..DelegatedTaskContract::default()
    });
    let allowlist = [WORKING_PLAN_CAPABILITY.into(), "local.file.read".into()];
    let options = ConversationOptions {
        workspace: root,
        conversation_id: conversation,
        resume_from: None,
        prompt: "Carry out the delegated task",
        image_paths: &[],
        provider_id: "openai",
        mode,
        effort: "default",
        persist_model_selection: false,
        allowlist: Some(&allowlist),
        max_turns: Some(max_turns),
    };
    let mut permission = CountPermission::default();
    let cancel = CancellationToken::new();
    let outcome = match surface {
        Surface::Worker => {
            runtime
                .execute_delegated(&options, &model, &mut permission, &cancel)
                .await
        }
        Surface::Verifier => {
            runtime
                .execute_verification(&options, &model, &mut permission, &cancel)
                .await
        }
        Surface::Foreground => {
            runtime
                .execute(&options, &model, &mut permission, &cancel)
                .await
        }
    }
    .unwrap();
    assert_eq!(outcome.error, None);
    let requests = server.await.unwrap();
    let history = std::fs::read_to_string(
        root.join("conversations")
            .join(format!("{}.jsonl", outcome.session_id)),
    )
    .unwrap();
    Episode {
        outcome,
        requests,
        history,
        approval_prompts: permission.0,
    }
}

fn plan(second_status: &str) -> Value {
    json!({
        "summary": "Verify the running work",
        "invariants": [INVARIANT],
        "steps": [
            {"title": "Prepare the fixture", "status": "completed"},
            {"title": "Verify the local result", "status": second_status, "check": CHECK},
        ],
    })
}

fn seeded_conversation(root: &Path, second_status: Option<&str>) -> String {
    let workspace = root.canonicalize().unwrap();
    let meta = ConversationStore::new(root)
        .create(
            &NewConversation {
                title: "Resume working plan",
                workspace_path: workspace.to_str(),
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_owned();
    if let Some(status) = second_status {
        let input: WorkingPlanInput = serde_json::from_value(plan(status)).unwrap();
        WorkingPlanStore::new(root)
            .upsert(&id, 0, input, AT)
            .unwrap();
    }
    id
}

fn system(request: &Value) -> &str {
    request["messages"][0]["content"].as_str().unwrap()
}

fn reminder_count(requests: &[Value]) -> usize {
    requests
        .iter()
        .filter(|request| request.to_string().contains(GUARD))
        .count()
}

#[tokio::test]
async fn update_plan_auto_approved_under_ask_before_local() {
    let home = tempfile::tempdir().unwrap();
    let run = episode(
        home.path(),
        Surface::Worker,
        RuntimeMode::Chat,
        None,
        5,
        vec![
            Reply::Call("update_plan", plan("completed")),
            Reply::Text("Complete"),
        ],
    )
    .await;
    assert_eq!(run.approval_prompts, 0);
    let snapshot = WorkingPlanStore::new(home.path())
        .read(&run.outcome.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.revision, 1);
    let rows: Vec<Value> = run
        .history
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let result = rows
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .find(|segment| segment["tool"] == "update_plan" && segment["result"].is_object())
        .unwrap();
    assert_eq!(result["result"]["output"]["revision"], 1);
    assert!(
        result["result"]["evidenceRefs"]
            .as_array()
            .is_none_or(Vec::is_empty)
    );
    assert!(run.history.contains("host_policy_working_plan"));
}

#[tokio::test]
async fn update_plan_preserves_byte_identical_system_prompt_for_kv_cache() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("fixture.txt"), "proof").unwrap();
    let run = episode(
        home.path(),
        Surface::Worker,
        RuntimeMode::Chat,
        None,
        5,
        vec![
            Reply::Call("update_plan", plan("in_progress")),
            Reply::Call("read_file", json!({"path":"fixture.txt"})),
            Reply::Call("update_plan", plan("completed")),
            Reply::Text("Complete"),
        ],
    )
    .await;
    let first = system(&run.requests[0]);
    assert!(run.requests.iter().all(|request| system(request) == first));
    assert!(!first.contains(INVARIANT));
    assert_eq!(reminder_count(&run.requests), 0);
    assert!(run.history.contains("proof"));
    assert_eq!(
        WorkingPlanStore::new(home.path())
            .read(&run.outcome.session_id)
            .unwrap()
            .unwrap()
            .revision,
        2
    );
}

#[tokio::test]
async fn working_plan_survives_compaction_and_reanchors_in_system_context() {
    for summary in [
        Reply::Text("Structural context from the worker"),
        Reply::Call("ignored", json!({})),
    ] {
        let home = tempfile::tempdir().unwrap();
        let run = episode(
            home.path(),
            Surface::Worker,
            RuntimeMode::Chat,
            None,
            2,
            vec![
                Reply::Call("update_plan", plan("in_progress")),
                Reply::Overflow,
                summary,
                Reply::Text("Post-compaction result"),
            ],
        )
        .await;
        let before = system(&run.requests[1]);
        let facts = run.requests[2].to_string();
        let after = system(&run.requests[3]);
        assert!(!before.contains(INVARIANT));
        assert!(
            facts.contains("Active working plan")
                && facts.contains(INVARIANT)
                && facts.contains(CHECK)
        );
        assert!(
            after.contains("Working plan snapshot (factual session state")
                && after.contains(INVARIANT)
                && after.contains(CHECK)
        );
        assert!(after.contains("Task contract for working plan tests"));
        let rows: Vec<Value> = run
            .history
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(rows.iter().any(|row| row["_compaction"].is_object()));
        let refs = rows.last().unwrap()["contextSnapshot"]["sectionRefs"]
            .as_array()
            .unwrap();
        assert!(refs.iter().any(|s| s["id"] == "runtime.working-plan"));
        assert!(refs.iter().any(|s| s["id"] == "delegated.contract"));
    }
}

#[tokio::test]
async fn completion_guard_fires_at_most_once_and_does_not_pollute_history() {
    let home = tempfile::tempdir().unwrap();
    let run = episode(
        home.path(),
        Surface::Worker,
        RuntimeMode::Chat,
        None,
        7,
        vec![
            Reply::Call("update_plan", plan("in_progress")),
            Reply::Text("Premature result"),
            Reply::Call("update_plan", plan("completed")),
            Reply::Text("Verified result"),
        ],
    )
    .await;
    assert_eq!(run.outcome.content, "Verified result");
    assert_eq!(reminder_count(&run.requests), 1);
    assert!(run.requests[2].to_string().contains(CHECK));
    assert!(!run.history.contains(GUARD));

    let conversation = seeded_conversation(home.path(), Some("pending"));
    let run = episode(
        home.path(),
        Surface::Worker,
        RuntimeMode::Chat,
        Some(&conversation),
        7,
        vec![
            Reply::Text("Still open"),
            Reply::Text("Report after reminder"),
        ],
    )
    .await;
    assert_eq!(run.outcome.turns, 2);
    assert_eq!(run.outcome.content, "Report after reminder");
    assert_eq!(reminder_count(&run.requests), 1);
    assert!(!run.history.contains(GUARD));
}

#[tokio::test]
async fn completion_guard_skips_when_all_steps_completed_or_blocked_or_no_plan() {
    for status in [None, Some("completed"), Some("blocked")] {
        let home = tempfile::tempdir().unwrap();
        let id = seeded_conversation(home.path(), status);
        let run = episode(
            home.path(),
            Surface::Worker,
            RuntimeMode::Chat,
            Some(&id),
            5,
            vec![Reply::Text("Report")],
        )
        .await;
        assert_eq!(run.outcome.turns, 1);
        assert_eq!(reminder_count(&run.requests), 0);
    }
}

#[tokio::test]
async fn delegated_verification_and_plan_mode_never_project_update_plan() {
    for (surface, mode) in [
        (Surface::Verifier, RuntimeMode::Chat),
        (Surface::Foreground, RuntimeMode::Plan),
        (Surface::Worker, RuntimeMode::Plan),
    ] {
        let home = tempfile::tempdir().unwrap();
        let run = episode(
            home.path(),
            surface,
            mode,
            None,
            5,
            vec![Reply::Text("Report")],
        )
        .await;
        let tools = run.requests[0]["tools"].as_array().unwrap();
        assert!(
            !tools
                .iter()
                .any(|tool| tool["function"]["name"] == "update_plan")
        );
        assert!(!system(&run.requests[0]).contains("update_plan"));
    }
}
