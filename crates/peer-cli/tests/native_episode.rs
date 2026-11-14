//! Public native executable, real HTTP/SSE, actual files and child processes.
//! All data is synthetic; PATH cannot find Node/Bun, and no OS secret is read.
use peer_runtime::coordination::NativeCoordinationReducer;
use peer_store::{
    AcquireLease, CoordinationStore, ExecutionResourceStore, HostIdentity, HostLeaseStore,
    HostSurface, PolicyStore,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
const AT: &str = "2026-11-14T04:00:00.000Z";
fn ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
fn put(path: impl AsRef<Path>, v: &Value) {
    std::fs::write(path, serde_json::to_vec(v).unwrap()).unwrap()
}
fn get(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(replies: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(15);
            let mut replies = replies.into_iter();
            while Instant::now() < deadline && !ended.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        // Darwin accept can inherit the listener's nonblocking
                        // flag. The controlled HTTP worker is intentionally blocking.
                        s.set_nonblocking(false).unwrap();
                        s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                        s.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                        let request = read_request(&mut s);
                        captured.lock().unwrap().push(request);
                        let reply = replies.next().unwrap_or_else(|| reply_text("done"));
                        let _ = write!(
                            s,
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            reply.len(),
                            reply
                        );
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let result = t.join();
            if !thread::panicking() {
                assert!(result.is_ok(), "controlled HTTP worker failed");
            }
        }
    }
}
fn read_request(s: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let mut one = [0; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 65536);
        s.read_exact(&mut one).unwrap();
        bytes.push(one[0]);
    }
    let headers = String::from_utf8(bytes).unwrap();
    let n = headers
        .lines()
        .find_map(|l| {
            l.to_lowercase()
                .strip_prefix("content-length:")
                .map(|s| s.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    assert!(n <= 2 * 1024 * 1024);
    let mut body = vec![0; n];
    s.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}
fn reply_tool(name: &str, args: Value) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"upstream-id","type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}})
    )
}
fn reply_text(text: &str) -> String {
    format!(
        "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}})
    )
}
struct Fixture {
    root: tempfile::TempDir,
}
static RECEIPT_LOCK: Mutex<()> = Mutex::new(());
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(output) = std::env::var_os("PEER_NATIVE_P3_EVIDENCE_ROOT") {
            let output = std::path::PathBuf::from(output);
            assert!(output.join(".native-cli-fixture").is_file());
            let _guard = RECEIPT_LOCK.lock().unwrap();
            self.root.disable_cleanup(true);
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(output.join("roots.jsonl"))
                .unwrap();
            writeln!(
                file,
                "{}",
                json!({"root":self.root.path(),"case":thread::current().name()})
            )
            .unwrap();
        }
    }
}
impl Fixture {
    fn new(server: &Server) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".native-cli-fixture"), "isolated").unwrap();
        std::fs::create_dir(root.path().join("workspace")).unwrap();
        std::fs::write(root.path().join("workspace/input.txt"), "source fact").unwrap();
        std::fs::create_dir_all(root.path().join("projects/w")).unwrap();
        put(
            root.path().join("projects/w/profile.json"),
            &json!({"workspaceId":"w","agentConversationId":"bot","status":"active","displayName":"Fixture","avatar":{"kind":"generated"}}),
        );
        PolicyStore::new(root.path())
            .initialize(peer_protocol::LocalAccessLevel::FullLocal, AT, None)
            .unwrap();
        ExecutionResourceStore::initialize(root.path(), None).unwrap();
        std::fs::create_dir(root.path().join("goal-plans")).unwrap();
        std::fs::write(root.path().join("goal-plans/index.jsonl"), "").unwrap();
        std::fs::create_dir(root.path().join("conversations")).unwrap();
        std::fs::write(root.path().join("conversations/index.jsonl"), "").unwrap();
        put(
            root.path().join("llm-providers.json"),
            &json!({"version":2,"channels":[{"id":"provider","channelId":"openai-compatible","authMethod":"api_key","baseUrl":server.url,"apiKeyConfigured":false}],"models":[{"id":"provider::model","groupId":"provider","model":"model","enabled":true,"supportsReasoning":false}]}),
        );
        let f = Self { root };
        f.seed("p", "c", "s", "work", "epoch");
        f
    }
    fn seed(&self, plan: &str, conversation: &str, session: &str, work: &str, epoch: &str) {
        let contracts: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/goal-execution-facts.json"
        ))
        .unwrap();
        let mut raw = contracts["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "delegated current identity")
            .unwrap()["raw"]
            .clone();
        for role in ["worker", "explorer", "verifier"] {
            raw["delegationOrigin"]["modelSelection"][role]["reasoningEffort"] = json!("off");
        }
        raw["planId"] = json!(plan);
        raw["conversationId"] = json!(conversation);
        raw["targetWorkspacePath"] = json!(self.root.path().join("workspace"));
        raw["title"] = json!("Native task");
        raw["goal"] =
            json!("Inspect input, write the requested file and verify it using actual tools.");
        raw["delegationOrigin"]["sessionId"] = json!(session);
        raw["delegationOrigin"]["workId"] = json!(work);
        raw["delegationOrigin"]["coordinationBinding"]["workId"] = json!(work);
        raw["delegationOrigin"]["coordinationBinding"]["executionEpoch"] = json!(epoch);
        put(
            self.root.path().join(format!("goal-plans/{plan}.json")),
            &raw,
        );
        let append = |path: &str, v: Value| {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(self.root.path().join(path))
                .unwrap();
            writeln!(f, "{v}").unwrap()
        };
        append(
            "goal-plans/index.jsonl",
            json!({"planId":plan,"title":"Native task","conversationId":conversation,"status":"executing","version":1,"createdAt":AT,"updatedAt":AT}),
        );
        append(
            "conversations/index.jsonl",
            json!({"id":conversation,"role":"work_session","workspaceId":"w","parentConversationId":"bot","title":"Native task","contentRevision":1,"messageCount":1,"createdAt":AT,"updatedAt":AT}),
        );
        std::fs::write(self.root.path().join(format!("conversations/{conversation}.jsonl")),format!("{}\n",json!({"id":format!("input-{conversation}"),"role":"user","content":"Carry out this assigned task through tools.","createdAt":AT}))).unwrap();
        let identity = HostIdentity::new(
            "fixture-seed",
            HostSurface::Tui,
            std::process::id(),
            "fixture",
        )
        .unwrap();
        let AcquireLease::Acquired { token, .. } = HostLeaseStore::new(self.root.path())
            .acquire("w", &identity, ms())
            .unwrap()
        else {
            panic!("isolated seed lease")
        };
        let mut journal = CoordinationStore::new(token);
        journal
            .initialize(&NativeCoordinationReducer, None)
            .unwrap();
        for entry in [
            json!({"kind":"work","work":{"workId":work,"state":"waiting_children","budget":{"modelRequests":0,"toolCalls":0,"tokens":0,"costUsd":0,"attempts":{}}}}),
            json!({"kind":"coordination_decision","mandate":{"workId":work,"lifecycle":"active","goalRevision":2},"receipt":{"operationId":format!("coordinate-{plan}"),"expectedRevision":0,"sourceInputIds":[format!("input-{conversation}")]},"transition":{"operationId":format!("coordinate-{plan}"),"schemaVersion":1,"minimumExecutorVersion":3,"phase":"ready","expectedGoalRevision":2,"executionEpoch":epoch}}),
        ] {
            let snapshot = journal.read(&NativeCoordinationReducer, None).unwrap();
            journal
                .append(&snapshot, &entry, ms(), &NativeCoordinationReducer, None)
                .unwrap();
        }
        journal.into_lease().release().unwrap();
    }
    fn command(&self, mode: &str, plan: &str) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_peer-native"));
        c.args([mode, "--plan", plan])
            .env("PEER_AGENT_HOME", self.root.path())
            .env("HOME", self.root.path())
            .env("PATH", "/nonexistent")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }
    fn run(&self) -> Output {
        self.command("exec", "p").output().unwrap()
    }
    fn history(&self) -> Vec<Value> {
        std::fs::read_to_string(self.root.path().join("conversations/c.jsonl"))
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect()
    }
}
#[test]
fn native_model_file_shell_result_evidence_and_pause_use_the_public_composition_root() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_tool(
            "write_file",
            json!({"path":"output.txt","content":"real write"}),
        ),
        reply_tool("bash", json!({"command":"printf native-shell"})),
        reply_text("Verified through real tools."),
    ]);
    let f = Fixture::new(&server);
    let result = f.run();
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let out: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(out["toolCalls"], 3);
    assert_eq!(out["goalAcceptance"], "pending");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/output.txt")).unwrap(),
        "real write"
    );
    let plan = get(f.root.path().join("goal-plans/p.json"));
    assert_eq!(plan["status"], "paused");
    assert_eq!(plan["delegationOrigin"]["phase"], "paused");
    assert_eq!(plan["tasks"][0]["status"], "pending");
    assert!(
        f.root
            .path()
            .join("goal-plans/evidence-index.jsonl")
            .is_file()
    );
    let history = f.history();
    let tools: Vec<_> = history
        .iter()
        .filter(|m| m["segments"].is_array())
        .collect();
    assert_eq!(tools.len(), 3);
    for m in tools {
        assert_ne!(m["segments"][0]["toolCallId"], "upstream-id");
        assert_eq!(m["segments"][0]["result"]["status"], "success");
    }
    assert_eq!(server.requests.lock().unwrap().len(), 4);
}
#[test]
fn denial_is_a_real_persisted_result_without_effect() {
    let server = Server::new(vec![
        reply_tool("write_file", json!({"path":"denied.txt","content":"never"})),
        reply_text("Permission was denied."),
    ]);
    let f = Fixture::new(&server);
    let store = PolicyStore::new(f.root.path());
    let old = store.read_existing("w").unwrap();
    store
        .update_existing(
            "w",
            old.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let r = f.run();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert!(!f.root.path().join("workspace/denied.txt").exists());
    assert_eq!(f.history()[1]["segments"][0]["result"]["status"], "denied");
    assert!(
        f.root
            .path()
            .join("project-runtime/w/approvals.jsonl")
            .exists()
    );
}
#[test]
fn truncated_stream_cannot_dispatch_a_partial_tool_and_next_task_can_run() {
    let full = reply_tool(
        "write_file",
        json!({"path":"partial.txt","content":"never"}),
    );
    let truncated = full.split("data: [DONE]").next().unwrap().to_owned();
    let server = Server::new(vec![truncated, reply_text("new task")]);
    let f = Fixture::new(&server);
    let r = f.run();
    assert_eq!(r.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&r.stderr).contains("model_stream_incomplete"));
    assert!(!f.root.path().join("workspace/partial.txt").exists());
    assert_eq!(
        get(f.root.path().join("goal-plans/p.json"))["status"],
        "paused"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let r = f.command("exec", "p2").output().unwrap();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
}
#[test]
fn foreground_timeout_is_reaped_and_persisted_as_failed() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"exec /bin/sleep 10","timeoutMs":20}),
        ),
        reply_text("Timed out, not verified."),
    ]);
    let f = Fixture::new(&server);
    let r = f.run();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    let h = f.history();
    assert_eq!(h[1]["segments"][0]["result"]["status"], "failed");
    assert_eq!(
        h[1]["segments"][0]["result"]["error"]["code"],
        "shell_timeout"
    );
    assert_eq!(h[1]["segments"][0]["result"]["output"]["timedOut"], true);
}

#[test]
fn created_file_can_be_read_and_edited_again_in_the_same_native_episode() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"created.txt","content":"first"}),
        ),
        reply_tool("read_file", json!({"path":"created.txt"})),
        reply_tool(
            "write_file",
            json!({"path":"created.txt","content":"second","allow_overwrite":true}),
        ),
        reply_tool("read_file", json!({"path":"created.txt"})),
        reply_text("Verified the edit."),
    ]);
    let f = Fixture::new(&server);
    let r = f.run();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/created.txt")).unwrap(),
        "second"
    );
    let tools: Vec<_> = f
        .history()
        .into_iter()
        .filter(|m| m["segments"].is_array())
        .collect();
    assert_eq!(tools.len(), 4);
    assert!(
        tools
            .iter()
            .all(|m| m["segments"][0]["result"]["status"] == "success")
    );
    assert_eq!(
        tools[3]["segments"][0]["result"]["output"]["content"],
        "second"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 5);
}
#[test]
fn existing_file_requires_a_real_read_and_preserves_the_owned_inode() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt","end_line":1})),
        reply_tool(
            "write_file",
            json!({"path":"input.txt","content":"verified edit","allow_overwrite":true}),
        ),
        reply_text("changed"),
    ]);
    let f = Fixture::new(&server);
    use std::os::unix::fs::MetadataExt;
    let before = std::fs::metadata(f.root.path().join("workspace/input.txt"))
        .unwrap()
        .ino();
    let r = f.run();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert_eq!(
        std::fs::metadata(f.root.path().join("workspace/input.txt"))
            .unwrap()
            .ino(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        "verified edit"
    );
}
#[test]
fn missing_read_and_destructive_or_unprojected_tools_cannot_write() {
    for (name, args, reason) in [
        (
            "write_file",
            json!({"path":"input.txt","content":"bad","allow_overwrite":true}),
            "file_read_required_or_changed",
        ),
        (
            "bash",
            json!({"command":"rm input.txt"}),
            "destructive_command",
        ),
        (
            "forged_tool",
            json!({"path":"input.txt"}),
            "tool_not_projected",
        ),
    ] {
        let server = Server::new(vec![reply_tool(name, args), reply_text("blocked")]);
        let f = Fixture::new(&server);
        let r = f.run();
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
            "source fact"
        );
        if name == "write_file" {
            assert_eq!(r.status.code(), Some(0));
            assert_eq!(
                f.history()[1]["segments"][0]["result"]["error"]["code"],
                reason
            )
        } else {
            assert_eq!(r.status.code(), Some(1));
            assert!(String::from_utf8_lossy(&r.stderr).contains(reason))
        }
    }
}
#[test]
fn unsupported_context_is_a_visible_blocker_before_model_dispatch() {
    let server = Server::new(vec![]);
    let f = Fixture::new(&server);
    std::fs::write(
        f.root.path().join("workspace/AGENTS.md"),
        "retained project instructions",
    )
    .unwrap();
    let r = f.run();
    assert_eq!(r.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&r.stderr)
            .contains("native_project_instruction_source_unsupported")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 0);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/AGENTS.md")).unwrap(),
        "retained project instructions"
    );
}

#[test]
fn inactive_bot_and_foreign_conversation_cannot_dispatch_cognition() {
    for archived in [true, false] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        if archived {
            let p = f.root.path().join("projects/w/profile.json");
            let mut profile = get(&p);
            profile["status"] = json!("archived");
            put(&p, &profile);
        } else {
            let p = f.root.path().join("conversations/index.jsonl");
            let mut meta: Value =
                serde_json::from_str(std::fs::read_to_string(&p).unwrap().trim()).unwrap();
            meta["workspaceId"] = json!("foreign");
            std::fs::write(p, format!("{meta}\n")).unwrap();
        }
        let r = f.run();
        assert_eq!(r.status.code(), Some(1));
        assert_eq!(server.requests.lock().unwrap().len(), 0);
        assert_eq!(get(f.root.path().join("goal-plans/p.json"))["version"], 1);
    }
}

#[test]
fn real_pty_permission_accept_deny_and_signal_have_no_stuck_stdin_reader() {
    for answer in [Some(true), Some(false), None] {
        let server = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"permission.txt","content":"approved effect"}),
            ),
            reply_text("finished"),
        ]);
        let f = Fixture::new(&server);
        let policy = PolicyStore::new(f.root.path());
        let old = policy.read_existing("w").unwrap();
        policy
            .update_existing(
                "w",
                old.revision,
                peer_protocol::LocalAccessLevel::AskBeforeLocal,
                AT,
            )
            .unwrap();
        let master =
            rustix::pty::openpt(rustix::pty::OpenptFlags::RDWR | rustix::pty::OpenptFlags::NOCTTY)
                .unwrap();
        rustix::io::fcntl_setfd(&master, rustix::io::FdFlags::CLOEXEC).unwrap();
        rustix::pty::grantpt(&master).unwrap();
        rustix::pty::unlockpt(&master).unwrap();
        let path = rustix::pty::ptsname(&master, Vec::new()).unwrap();
        let slave = rustix::fs::open(
            path.as_c_str(),
            rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOCTTY | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )
        .unwrap();
        let mut child = f
            .command("exec", "p")
            .stdin(Stdio::from(rustix::io::dup(&slave).unwrap()))
            .stderr(Stdio::from(slave))
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut bytes = Vec::new();
        while !String::from_utf8_lossy(&bytes).contains("[y/N]") {
            assert!(
                Instant::now() < deadline,
                "approval prompt missing: {}",
                String::from_utf8_lossy(&bytes)
            );
            let mut poll = [rustix::event::PollFd::new(
                &master,
                rustix::event::PollFlags::IN,
            )];
            if rustix::event::poll(
                &mut poll,
                Some(&rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 20_000_000,
                }),
            )
            .unwrap()
                > 0
            {
                let mut b = [0; 8192];
                let n = rustix::io::read(&master, &mut b).unwrap();
                bytes.extend_from_slice(&b[..n]);
            }
        }
        if let Some(allow) = answer {
            rustix::io::write(&master, if allow { b"y\n" } else { b"n\n" }).unwrap();
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "permission stdin did not settle");
            thread::sleep(Duration::from_millis(10))
        }
        let r = child.wait_with_output().unwrap();
        assert_eq!(
            r.status.code(),
            Some(if answer.is_none() { 4 } else { 0 }),
            "{}",
            String::from_utf8_lossy(&r.stderr)
        );
        assert_eq!(
            f.root.path().join("workspace/permission.txt").exists(),
            answer == Some(true)
        );
        assert_eq!(
            get(f.root.path().join("goal-plans/p.json"))["status"],
            "paused"
        );
    }
}

#[test]
fn actual_signal_cancels_owned_shell_and_later_task_is_admitted() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf started; exec /bin/sleep 10","timeoutMs":15000}),
        ),
        reply_text("later"),
    ]);
    let f = Fixture::new(&server);
    let mut child = f.command("exec", "p").spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline
        && std::fs::read_dir(f.root.path().join("shell-artifacts")).is_err()
    {
        thread::sleep(Duration::from_millis(10))
    }
    assert!(f.root.path().join("shell-artifacts").is_dir());
    thread::sleep(Duration::from_millis(50));
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "native process did not stop");
        thread::sleep(Duration::from_millis(10))
    }
    let r = child.wait_with_output().unwrap();
    assert_eq!(
        r.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    let h = f.history();
    assert_eq!(h[1]["segments"][0]["result"]["status"], "cancelled");
    assert_eq!(
        get(f.root.path().join("goal-plans/p.json"))["status"],
        "paused"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let r = f.command("exec", "p2").output().unwrap();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn crash_after_file_effect_is_unknown_and_native_recovery_never_replays_it() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"uncertain.txt","content":"effect before receipt"}),
        ),
        reply_tool(
            "write_file",
            json!({"path":"different.txt","content":"new task"}),
        ),
        reply_text("new task finished"),
    ]);
    let f = Fixture::new(&server);
    let r = f
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "write_file")
        .output()
        .unwrap();
    assert_eq!(
        r.status.code(),
        Some(77),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/uncertain.txt")).unwrap(),
        "effect before receipt"
    );
    assert_eq!(f.history().len(), 1);
    // Controlled fixture only: after wait_with_output proves that process is
    // dead, age its lease to exercise the real existing stale acquisition rule.
    let lease = f.root.path().join("project-runtime/w/host.lease");
    let mut raw = get(&lease);
    raw["heartbeatAt"] = json!(AT);
    put(&lease, &raw);
    let r = f.command("exec", "p").output().unwrap();
    assert_eq!(r.status.code(), Some(1));
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "restart must not call the model or replay the tool"
    );
    let r = f.command("recover", "p").output().unwrap();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    let recovered: Value = serde_json::from_slice(&r.stdout).unwrap();
    assert_eq!(recovered["facts"]["control"]["phase"], "reconciling");
    assert_eq!(
        recovered["facts"]["control"]["stopReceipt"]["unknownCalls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/uncertain.txt")).unwrap(),
        "effect before receipt"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let r = f.command("exec", "p2").output().unwrap();
    assert_eq!(
        r.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&r.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/different.txt")).unwrap(),
        "new task"
    );
    let old = get(f.root.path().join("goal-plans/p.json"));
    assert_eq!(
        old["delegationOrigin"]["executionControl"]["phase"],
        "reconciling"
    );
}
