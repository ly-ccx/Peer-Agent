//! Public native Host and real fixed system Git, all repositories/data owned.
use super::*;
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
pub(super) fn next_reply(reply: String, request: &Value) -> String {
    if !matches!(
        reply.as_str(),
        "FIXTURE_GIT_READ_SAVED_REFERENCE"
            | "FIXTURE_GIT_READ_LEGACY_PATH"
            | "FIXTURE_READ_SKILL_REFERENCE"
    ) {
        return reply;
    }
    let content = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    let view: Value = serde_json::from_str(content).unwrap();
    if reply == "FIXTURE_READ_SKILL_REFERENCE" {
        let reference = &view["nativeContentRef"];
        let offset = reference["bytes"].as_u64().unwrap().saturating_sub(1024);
        return reply_tool(
            "read_tool_result",
            json!({"reference":reference,"offset":offset,"length":1024}),
        );
    }
    if reply == "FIXTURE_GIT_READ_SAVED_REFERENCE" {
        reply_tool(
            "read_tool_result",
            json!({"reference":view["output"]["nativeContentRef"],"offset":0,"length":262144}),
        )
    } else {
        reply_tool("read_file", json!({"path":view["output"]["artifactPath"]}))
    }
}
fn git(f: &Fixture, cwd: &str, args: &[&str]) -> String {
    let out = Command::new("/usr/bin/git")
        .args(args)
        .current_dir(f.root.path().join(cwd))
        .env_clear()
        .env("HOME", f.root.path())
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Native Fixture")
        .env("GIT_AUTHOR_EMAIL", "native@example.invalid")
        .env("GIT_COMMITTER_NAME", "Native Fixture")
        .env("GIT_COMMITTER_EMAIL", "native@example.invalid")
        .env("GIT_AUTHOR_DATE", "2026-11-17T00:00:00+05:30")
        .env("GIT_COMMITTER_DATE", "2026-11-17T00:00:00+05:30")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
fn repository(f: &Fixture) -> String {
    git(f, "workspace", &["init", "--initial-branch=main"]);
    git(f, "workspace", &["add", "input.txt"]);
    git(f, "workspace", &["commit", "-m", "owned original"]);
    git(f, "workspace", &["rev-parse", "HEAD"])
}
#[test]
fn public_native_git_snapshot_keeps_the_real_child_artifact_and_evidence_chain() {
    let server = Server::new(vec![
        reply_tool("git_query", json!({"path":".","limit":2})),
        reply_text("Observation saved."),
    ]);
    let f = Fixture::new(&server);
    let head = repository(&f);
    // Explicitly reproduce runners with an existing global Git filter. The
    // actual product strips GIT_* overrides, so fixture-only NOSYSTEM during
    // repository setup cannot imply a filter-free query environment.
    std::fs::write(
        f.root.path().join(".gitconfig"),
        "[filter \"native-fixture\"]\nclean = touch never-run-filter\n",
    )
    .unwrap();
    std::fs::write(
        f.root.path().join("workspace/untracked🦀.txt"),
        "owned fact",
    )
    .unwrap();
    let index = std::fs::read(f.root.path().join("workspace/.git/index")).unwrap();
    let run = f.run();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    assert_eq!(
        std::fs::read(f.root.path().join("workspace/.git/index")).unwrap(),
        index
    );
    assert!(!f.root.path().join("workspace/.git/index.lock").exists());
    let message = f
        .history()
        .into_iter()
        .find(|m| m["segments"][0]["tool"] == "git_query")
        .unwrap();
    let result = &message["segments"][0]["result"];
    assert_eq!(result["status"], "success", "{result}");
    let out = &result["output"];
    assert_eq!(out["kind"], "local_git_observation");
    assert_eq!(out["head"], head);
    assert_eq!(out["atomic"], false);
    assert_eq!(out["consistent"], true);
    assert_eq!(out["status"]["untracked"], 1);
    // A disabled configured filter makes final cleanliness unknown, even when
    // the restricted observation sees an untracked file (ADR106).
    assert_eq!(out["status"]["filtersDisabled"], true);
    assert!(out["status"]["clean"].is_null());
    assert!(!f.root.path().join("workspace/never-run-filter").exists());
    assert_eq!(message["permissionGrants"][0]["granted"], true);
    assert_eq!(message["permissionGrants"][0]["scope"]["kind"], "file-read");
    let process = &result["evidence"]["nativeProcess"];
    assert_eq!(process["state"], "ended");
    assert_eq!(process["stopObservation"], "owned_completion");
    assert!(process["generation"].as_u64().unwrap() >= 10);
    assert!(process["child"]["pid"].as_u64().unwrap() > 0);
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(out["nativeContentRef"].clone()).unwrap();
    let store = peer_store::ToolArtifactStore::new(f.root.path());
    let path = store.path("c", &reference).unwrap();
    assert_eq!(out["artifactPath"], json!(path));
    let saved: Value = serde_json::from_slice(
        &store
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap()
            .bytes,
    )
    .unwrap();
    assert_eq!(saved["head"], head);
    assert_eq!(saved["status"]["entries"][0]["path"], "untracked🦀.txt");
    assert_eq!(saved["kind"], "local_git_observation");
    assert!(
        result["evidence"]["artifactRefs"]
            .as_array()
            .unwrap()
            .contains(&json!(path))
    );
    let manifest = get(f
        .root
        .path()
        .join("project-runtime/w/coordination-v2/manifest.json"));
    assert_eq!(manifest["minimumReaderVersion"], 13);
    assert_eq!(manifest["minimumWriterVersion"], 13);
    assert_eq!(
        get(f.root.path().join("goal-plans/p.json"))["status"],
        "paused"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn public_native_git_model_can_read_both_saved_reference_and_legacy_artifact_path() {
    for (marker, tool) in [
        ("FIXTURE_GIT_READ_SAVED_REFERENCE", "read_tool_result"),
        ("FIXTURE_GIT_READ_LEGACY_PATH", "read_file"),
    ] {
        let server = Server::new(vec![
            reply_tool("git_query", json!({"path":"."})),
            marker.into(),
            reply_text("Saved observation retrieved."),
        ]);
        let f = Fixture::new(&server);
        let head = repository(&f);
        success(&f.run());
        let history = f.history();
        let git = history
            .iter()
            .find(|m| m["segments"][0]["tool"] == "git_query")
            .unwrap();
        let read = history
            .iter()
            .find(|m| m["segments"][0]["tool"] == tool)
            .unwrap();
        assert_eq!(read["permissionGrants"][0]["granted"], true);
        let r = &read["segments"][0]["result"];
        assert_eq!(r["status"], "success", "{r}");
        assert!(r["evidence"].is_object());
        let content = r["output"]["content"].as_str().unwrap();
        let observation: Value = serde_json::from_str(content).unwrap();
        assert_eq!(observation["head"], head);
        assert_eq!(observation["kind"], "local_git_observation");
        assert_eq!(
            observation["repositoryPath"],
            git["segments"][0]["result"]["output"]["repositoryPath"]
        );
        assert_eq!(server.requests.lock().unwrap().len(), 3);
    }
}

fn ask(f: &Fixture) {
    let p = PolicyStore::new(f.root.path());
    let old = p.read_existing("w").unwrap();
    p.update_existing(
        "w",
        old.revision,
        peer_protocol::LocalAccessLevel::AskBeforeLocal,
        AT,
    )
    .unwrap();
}

#[test]
fn public_native_git_external_include_requires_its_own_real_pty_scope_decision() {
    for allow in [true, false] {
        let server = Server::new(vec![
            reply_tool("git_query", json!({"path":"."})),
            reply_text("Decision observed."),
        ]);
        let f = Fixture::new(&server);
        repository(&f);
        let outside = f.root.path().join("outside-config");
        std::fs::write(&outside, "[remote \"origin\"]\nurl = https://user:secret@example.invalid/owned\n[filter \"unsafe\"]\nclean = touch must-not-exist\n").unwrap();
        git(
            &f,
            "workspace",
            &["config", "include.path", outside.to_str().unwrap()],
        );
        ask(&f);
        let index = std::fs::read(f.root.path().join("workspace/.git/index")).unwrap();
        let (master, mut child) = permission_pty(&f);
        let canonical_outside = std::fs::canonicalize(&outside).unwrap();
        let mut other_scopes = 0;
        loop {
            let prompt = scope_prompt(&master);
            let scope = &prompt["scopes"][0];
            assert_eq!(scope["kind"], "file-read");
            assert_eq!(scope["capabilityId"], "local.git.query");
            if scope["path"] == json!(canonical_outside) {
                thread::sleep(Duration::from_secs(6));
                assert!(
                    child.child().try_wait().unwrap().is_none(),
                    "approval wait must stay live and retain its lease"
                );
                rustix::io::write(&master, if allow { b"y\n" } else { b"n\n" }).unwrap();
                break;
            }
            // Real platform Git may report a system config before our include.
            // Approve that distinct displayed scope, never pretend the first
            // prompt belongs to the test-owned include or grant all at once.
            assert!(Path::new(scope["path"].as_str().unwrap()).is_file());
            other_scopes += 1;
            assert!(other_scopes < 128);
            rustix::io::write(&master, b"y\n").unwrap();
        }
        wait_permission_decision(&f, if allow { "approved" } else { "denied" });
        success(&wait_git_episode(child));
        let history = f.history();
        let m = history
            .iter()
            .find(|m| m["segments"][0]["tool"] == "git_query")
            .unwrap();
        assert_eq!(
            m["permissionGrants"][0]["granted"], true,
            "root read grant remains factual after supplemental denial"
        );
        let grants = m["permissionGrants"].as_array().unwrap();
        assert_eq!(grants.len(), 2 + other_scopes);
        let decision = grants
            .iter()
            .find(|g| g["scope"]["path"] == json!(canonical_outside))
            .unwrap();
        assert_eq!(decision["granted"], allow);
        let r = &m["segments"][0]["result"];
        assert_eq!(r["status"], if allow { "success" } else { "denied" }, "{r}");
        assert_eq!(r["evidence"]["nativeProcess"]["state"], "ended");
        if allow {
            assert_eq!(r["output"]["status"]["filtersDisabled"], true);
            assert!(r["output"]["status"]["clean"].is_null());
            assert!(!r.to_string().contains("user:secret"));
        } else {
            assert!(!f.root.path().join("conversations/c.tool-results").exists());
        }
        assert!(!f.root.path().join("workspace/must-not-exist").exists());
        assert_eq!(
            std::fs::read(f.root.path().join("workspace/.git/index")).unwrap(),
            index
        );
        assert!(!f.root.path().join("workspace/.git/index.lock").exists());
    }
}

fn scope_prompt(master: &std::os::fd::OwnedFd) -> Value {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut bytes = Vec::new();
    loop {
        let text = String::from_utf8_lossy(&bytes);
        if text.contains("[y/N]") {
            return text
                .lines()
                .find_map(|line| {
                    line.find('{')
                        .and_then(|at| serde_json::from_str(&line[at..]).ok())
                })
                .expect("actual scope JSON in terminal prompt");
        }
        assert!(Instant::now() < deadline, "scope prompt missing: {text}");
        let mut poll = [rustix::event::PollFd::new(
            master,
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
            let mut chunk = [0; 8192];
            let count = rustix::io::read(master, &mut chunk).unwrap();
            assert!(bytes.len() + count <= 65536, "bounded displayed prompt");
            bytes.extend_from_slice(&chunk[..count]);
        }
    }
}

fn wait_git_episode(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(45);
    while child.child().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "Git Host did not settle");
        thread::sleep(Duration::from_millis(10));
    }
    child.output()
}

#[test]
fn public_native_git_invalid_input_and_unavailable_external_approval_never_spawn() {
    for args in [
        json!({"path":".","operation":"fetch"}),
        json!({"path":".","limit":0}),
        json!({"path":"." ,"argv":["status"]}),
        json!({"path":"/outside-not-read"}),
    ] {
        let server = Server::new(vec![
            reply_tool("git_query", args),
            reply_text("Failure observed."),
        ]);
        let f = Fixture::new(&server);
        repository(&f);
        ask(&f);
        success(&f.run());
        let h = f.history();
        let m = h
            .iter()
            .find(|m| m["segments"][0]["tool"] == "git_query")
            .unwrap();
        let r = &m["segments"][0]["result"];
        assert_eq!(r["status"], "failed", "{r}");
        assert_eq!(r["evidence"]["dispatchOutcome"], "not_dispatched");
        assert!(r["evidence"]["nativeProcess"].is_null());
        assert_eq!(m["permissionGrants"][0]["granted"], false);
        assert!(!f.root.path().join("conversations/c.tool-results").exists());
        assert!(
            !f.root
                .path()
                .join("project-runtime/w/approvals.jsonl")
                .exists()
        );
    }
    let server = Server::new(vec![
        reply_tool("git_query", json!({"path":".."})),
        reply_text("Denied."),
    ]);
    let f = Fixture::new(&server);
    repository(&f);
    ask(&f);
    success(&f.run());
    let h = f.history();
    let m = h
        .iter()
        .find(|m| m["segments"][0]["tool"] == "git_query")
        .unwrap();
    let r = &m["segments"][0]["result"];
    assert_eq!(r["status"], "denied");
    assert_eq!(r["evidence"]["dispatchOutcome"], "not_dispatched");
    assert!(r["evidence"]["nativeProcess"].is_null());
    let approvals =
        std::fs::read_to_string(f.root.path().join("project-runtime/w/approvals.jsonl")).unwrap();
    let last: Value = serde_json::from_str(approvals.lines().last().unwrap()).unwrap();
    assert_eq!(last["decidedBy"], "policy");
    assert_eq!(last["decisionReason"], "permission_unavailable");
}

fn readonly(f: &Fixture) {
    let path = f.root.path().join("goal-plans/p.json");
    let mut plan = get(&path);
    plan["delegationOrigin"]["readOnly"] = json!(true);
    // Exercise the real empty-target fallback while preserving exact path text.
    plan["targetWorkspacePath"] = json!("");
    plan["originWorkspacePath"] = json!(f.root.path().join("workspace"));
    put(path, &plan);
}

#[test]
fn public_native_readonly_git_uses_a_read_anchor_without_claiming_a_write_directory() {
    let server = Server::new(vec![
        reply_tool("git_query", json!({"path":"."})),
        reply_text("Readonly observed."),
    ]);
    let f = Fixture::new(&server);
    repository(&f);
    readonly(&f);
    success(&f.run());
    let goal = peer_store::GoalStore::new(f.root.path())
        .read(
            "p",
            &peer_runtime::goal_facts::TuiGoalProjector::new(AT).unwrap(),
            None,
        )
        .unwrap();
    assert!(goal.facts["resourceDirectory"].is_null());
    let resource = peer_store::HostResourcePlan {
        execution: peer_protocol::normalize_session_execution_identity(&goal.facts["execution"])
            .unwrap(),
        workspace_id: "w".into(),
        directory: None,
        read_only: true,
        title: "owned readonly".into(),
    };
    assert!(
        peer_store::ExecutionResourceStore::initialize(f.root.path(), None)
            .unwrap()
            .claims_for(&resource)
            .unwrap()
            .is_empty()
    );
    let h = f.history();
    let m = h
        .iter()
        .find(|m| m["segments"][0]["tool"] == "git_query")
        .unwrap();
    let r = &m["segments"][0]["result"];
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["evidence"]["nativeProcess"]["state"], "ended");
    assert_eq!(
        m["permissionGrants"][0]["scope"]["path"],
        json!(std::fs::canonicalize(f.root.path().join("workspace")).unwrap())
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn public_native_readonly_git_hard_exit_keeps_original_artifact_and_unknown_without_replay() {
    let server = Server::new(vec![
        reply_tool("git_query", json!({"path":"."})),
        reply_text("Independent task."),
    ]);
    let f = Fixture::new(&server);
    repository(&f);
    readonly(&f);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "git_query")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(77),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(f.history().len(), 1);
    let directory = f.root.path().join("conversations/c.tool-results");
    let artifacts: Vec<_> = std::fs::read_dir(&directory)
        .unwrap()
        .map(|e| {
            let p = e.unwrap().path();
            (p.clone(), std::fs::read(p).unwrap())
        })
        .collect();
    assert!(!artifacts.is_empty());
    f.age_dead_lease();
    assert!(!f.run().status.success());
    success(&f.command("recover", "p").output().unwrap());
    let unknown = f.budget(|_| {});
    assert_eq!(unknown["uncertainDispatches"].as_array().unwrap().len(), 1);
    assert_eq!(
        unknown["uncertainDispatches"][0]["nativeProcess"]["state"],
        "ended"
    );
    assert_eq!(
        unknown["uncertainDispatches"][0]["nativeProcess"]["stopObservation"],
        "owned_completion"
    );
    success(&f.command("recover", "p").output().unwrap());
    assert_eq!(f.budget(|_| {}), unknown);
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    success(&f.command("exec", "p2").output().unwrap());
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert_eq!(f.budget(|_| {}), unknown);
    assert_eq!(f.history().len(), 1);
    for (path, bytes) in artifacts {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn public_native_git_fixed_metadata_overflow_keeps_full_identity_in_existing_json_artifacts() {
    let server = Server::new(vec![
        reply_tool("git_query", json!({"path":".","limit":1})),
        reply_text("Saved large identity."),
    ]);
    let f = Fixture::new(&server);
    repository(&f);
    let deep = f
        .root
        .path()
        .join("outside-configs")
        .join("a".repeat(160))
        .join("b".repeat(160));
    std::fs::create_dir_all(&deep).unwrap();
    let mut expected = Vec::new();
    for n in 0..9 {
        let path = deep.join(format!("cfg-{n}-{}", "c".repeat(100)));
        std::fs::write(&path, format!("[native]\nkey{n} = owned\n")).unwrap();
        git(
            &f,
            "workspace",
            &["config", "--add", "include.path", path.to_str().unwrap()],
        );
        expected.push(json!(std::fs::canonicalize(path).unwrap()));
    }
    success(&f.run());
    let h = f.history();
    let r = &h
        .iter()
        .find(|m| m["segments"][0]["tool"] == "git_query")
        .unwrap()["segments"][0]["result"];
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["kind"], "local_tool_result_ref");
    assert!(r["output"].to_string().encode_utf16().count() <= 4000);
    let store = peer_store::ToolArtifactStore::new(f.root.path());
    let read = |value: &Value| -> Value {
        let reference: peer_store::ToolArtifactRef = serde_json::from_value(value.clone()).unwrap();
        let window = store
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap();
        assert!(window.complete);
        serde_json::from_slice(&window.bytes).unwrap()
    };
    let preview = read(&r["output"]["nativeContentRef"]);
    assert_eq!(preview["kind"], "local_git_observation");
    assert_eq!(preview["contextPreviewTruncated"], true);
    let full = read(&preview["nativeContentRef"]);
    for source in expected {
        assert!(
            full["configurationSources"]
                .as_array()
                .unwrap()
                .contains(&source),
            "untruncated config identity {source}"
        );
    }
    assert_eq!(
        preview["configurationSources"],
        full["configurationSources"]
    );
    assert_eq!(r["evidence"]["artifactRefs"].as_array().unwrap().len(), 2);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn public_native_readonly_child_recovery_kills_only_the_recorded_group_and_retains_unknown() {
    use std::os::unix::process::CommandExt;
    for phase in ["running", "starting", "reused"] {
        let server = Server::new(vec![reply_tool("git_query", json!({"path":"."}))]);
        let f = Fixture::new(&server);
        repository(&f);
        readonly(&f);
        let out = f
            .command("exec", "p")
            .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "git_query")
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(77));
        f.age_dead_lease();
        let pending = f.budget(|_| {});
        let owner = pending["attempts"]
            .as_object()
            .unwrap()
            .values()
            .next()
            .unwrap()["pendingTools"][0]["nativeProcess"]["owner"]
            .clone();
        // Explicit persisted-state recovery fixture: this child is test-owned,
        // not claimed to have been left by the already completed Git command.
        // The real OS tuple and canonical recovery/kill seam remain unchanged.
        let mut sleeper = OwnedChild(Some(
            Command::new("/bin/sleep")
                .arg("60")
                .process_group(0)
                .spawn()
                .unwrap(),
        ));
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut observed = runtime
            .block_on(peer_runtime::recorder::process_recorder(
                sleeper.child().id(),
                owner["hostId"].as_str().unwrap(),
                owner["acquiredAt"].as_str().unwrap(),
            ))
            .unwrap();
        if phase == "reused" {
            observed.pid_start = "different-original-pid-start".into();
        }
        let changed = f.budget(|budget| {
            let attempt = budget["attempts"]
                .as_object_mut()
                .unwrap()
                .values_mut()
                .next()
                .unwrap();
            let process = &mut attempt["pendingTools"][0]["nativeProcess"];
            process["state"] = json!(if phase == "starting" {
                "starting"
            } else {
                "running"
            });
            process.as_object_mut().unwrap().remove("stopObservation");
            if phase == "starting" {
                process.as_object_mut().unwrap().remove("child");
            } else {
                process["child"] = json!(observed);
            }
        });
        // A real OS child must be reaped by its owner before the process group
        // can disappear on Darwin. Run that owner concurrently with recovery.
        let reaper = Reaper::new(sleeper.0.take().unwrap());
        let result = f.command("recover", "p").output().unwrap();
        if phase == "running" {
            success(&result);
            assert!(!reaper.wait().success());
            let after = f.budget(|_| {});
            let rows = after["uncertainDispatches"].as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0]["nativeProcess"]["state"], "ended");
            assert_eq!(
                rows[0]["nativeProcess"]["stopObservation"],
                "owner_dead_group_absent"
            );
            assert_eq!(rows[0]["nativeProcess"]["child"]["pid"], observed.pid);
            assert_eq!(f.history().len(), 1);
            success(&f.command("recover", "p").output().unwrap());
            assert_eq!(f.budget(|_| {}), after);
        } else {
            assert!(!result.status.success());
            assert!(
                String::from_utf8_lossy(&result.stderr).contains("native_execution_stop_unproven")
            );
            assert_eq!(f.budget(|_| {}), changed);
            assert!(
                rustix::process::test_kill_process(
                    rustix::process::Pid::from_raw(observed.pid as i32).unwrap()
                )
                .is_ok(),
                "unproven/reused child must not be killed"
            );
            rustix::process::kill_process_group(
                rustix::process::Pid::from_raw(observed.pid as i32).unwrap(),
                rustix::process::Signal::KILL,
            )
            .unwrap();
            reaper.wait();
        }
        assert_eq!(
            server.requests.lock().unwrap().len(),
            1,
            "recovery never replays the Git/tool/model"
        );
    }
}

#[cfg(feature = "test-fixtures")]
struct Reaper {
    keep: Option<std::sync::mpsc::Sender<()>>,
    owner: Option<thread::JoinHandle<std::process::ExitStatus>>,
}
#[cfg(feature = "test-fixtures")]
impl Reaper {
    fn new(mut child: std::process::Child) -> Self {
        let (keep, gone) = std::sync::mpsc::channel();
        let owner = thread::spawn(move || {
            loop {
                if let Some(status) = child.try_wait().unwrap() {
                    break status;
                }
                if !matches!(gone.try_recv(), Err(std::sync::mpsc::TryRecvError::Empty)) {
                    let _ = child.kill();
                    break child.wait().unwrap();
                }
                thread::sleep(Duration::from_millis(5));
            }
        });
        Self {
            keep: Some(keep),
            owner: Some(owner),
        }
    }
    fn wait(mut self) -> std::process::ExitStatus {
        self.owner.take().unwrap().join().unwrap()
    }
}
#[cfg(feature = "test-fixtures")]
impl Drop for Reaper {
    fn drop(&mut self) {
        self.keep.take();
        if let Some(owner) = self.owner.take() {
            owner.join().unwrap();
        }
    }
}
