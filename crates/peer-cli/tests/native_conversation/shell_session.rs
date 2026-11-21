//! Exercises the ordinary CLI, actual provider and canonical execution Store.
use super::*;

#[test]
fn public_foreground_shell_keeps_one_interpreter_and_settles_each_call() {
    let fixture = Ordinary::new();
    let workspace = fixture.workspace();
    std::fs::create_dir(workspace.join("nested")).unwrap();
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({
                "command": "cd nested; export PEER_FIXTURE_VALUE=retained; peer_fixture_fn() { printf function; }; printf '%s' \"$$\" > first.pid; printf ready"
            }),
        ),
        reply_tool(
            "bash",
            json!({
                "command": "printf '%s:' \"${PEER_FIXTURE_VALUE:-empty}\"; if command -v peer_fixture_fn >/dev/null; then peer_fixture_fn; else printf missing; fi; printf ':%s' \"${PWD##*/}\"; printf '%s' \"$$\" > second.pid"
            }),
        ),
        reply_text("Both calls returned."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--tools",
            "bash",
            "--access",
            "full",
            "--output-format",
            "json",
            "Check retained shell state",
        ],
        None,
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "stdout={} stderr={} runtime={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        fixture.metadata()["runtimeExecution"]
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    let last_output = |turn: usize| {
        let tool = requests[turn]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap();
        serde_json::from_str::<Value>(tool["content"].as_str().unwrap()).unwrap()
    };
    let first_output = last_output(1);
    assert_eq!(first_output["stdoutPreview"], "ready", "{first_output}");
    assert_eq!(last_output(2)["stdoutPreview"], "retained:function:nested");
    let nested = workspace.join("nested");
    let first_pid = std::fs::read_to_string(nested.join("first.pid")).unwrap();
    let second_pid = std::fs::read_to_string(nested.join("second.pid")).unwrap();
    assert_eq!(first_pid, second_pid);
    let pid = rustix::process::Pid::from_raw(first_pid.parse().unwrap()).unwrap();
    assert_eq!(
        rustix::process::test_kill_process_group(pid),
        Err(rustix::io::Errno::SRCH)
    );
    let reply = fixture.assert_settled(&output, 3, 2);
    let history = ConversationStore::new(fixture.home())
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let tools: Vec<_> = history
        .history
        .messages
        .iter()
        .flat_map(|message| message["segments"].as_array().into_iter().flatten())
        .filter(|segment| segment["type"] == "tool-call")
        .map(|segment| &segment["result"])
        .collect();
    let first = &tools[0]["evidence"]["shellSession"];
    let second = &tools[1]["evidence"]["shellSession"];
    assert!(
        first["handleId"]
            .as_str()
            .unwrap()
            .starts_with("shell-session_")
    );
    assert_eq!(first["handleId"], second["handleId"]);
    assert_eq!(first["generation"], second["generation"]);
    assert_ne!(first["dispatchId"], second["dispatchId"]);
}

#[test]
fn public_foreground_shell_keeps_late_bytes_with_the_original_call() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({
                "command": "(while [ ! -f release ]; do /bin/sleep 0.025; done; printf late-out; printf late-err >&2; printf complete > original-done) & printf start"
            }),
        ),
        reply_tool(
            "bash",
            json!({
                "command": "printf start > release; while [ ! -f original-done ]; do /bin/sleep 0.025; done; printf second-out; printf second-err >&2",
                "timeoutMs": 4000
            }),
        ),
        reply_text("Observed distinct output."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--tools",
            "bash",
            "--access",
            "full",
            "--output-format",
            "json",
            "Observe own output",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 3, 2);
    let history = ConversationStore::new(fixture.home())
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let tools: Vec<_> = history
        .history
        .messages
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .filter(|segment| segment["type"] == "tool-call")
        .map(|segment| &segment["result"])
        .collect();
    assert_eq!(tools[1]["output"]["stdout"], "second-out");
    assert_eq!(tools[1]["output"]["stderr"], "second-err");
    let first_id = tools[0]["output"]["taskId"].as_str().unwrap();
    let dir = std::fs::read_dir(fixture.home().join("shell-artifacts"))
        .unwrap()
        .map(|day| day.unwrap().path().join(first_id))
        .find(|path| path.is_dir())
        .unwrap();
    assert_eq!(
        std::fs::read(dir.join("stdout.txt")).unwrap(),
        b"startlate-out"
    );
    assert_eq!(std::fs::read(dir.join("stderr.txt")).unwrap(), b"late-err");
    let metadata = get(dir.join("metadata.json"));
    assert_eq!(metadata["captureStatus"], "complete");
}
