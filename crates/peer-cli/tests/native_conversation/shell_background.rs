//! Real shell process groups behind the public native exec model/Tool boundary.
use super::*;
use std::{fs, path::PathBuf};

fn model_result(request: &Value) -> Value {
    let row = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|row| row["role"] == "tool")
        .unwrap();
    serde_json::from_str(row["content"].as_str().unwrap()).unwrap()
}

fn recorded_pid(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Ok(contents) = fs::read_to_string(path)
            && let Ok(pid) = contents.parse()
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "unobserved startup at {}",
            path.display()
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn group_absent(pid: u32) -> bool {
    let pid = rustix::process::Pid::from_raw(i32::try_from(pid).unwrap()).unwrap();
    rustix::process::test_kill_process_group(pid) == Err(rustix::io::Errno::SRCH)
}

fn artifacts(home: &Path, task: &str) -> PathBuf {
    fs::read_dir(home.join("shell-artifacts"))
        .unwrap()
        .map(|day| day.unwrap().path().join(task))
        .find(|path| path.is_dir())
        .unwrap()
}

#[test]
fn public_shell_background_returns_before_exit_then_stops_only_the_original_handle() {
    let fixture = Ordinary::new();
    let work = fixture.workspace();
    let mut turn = 0;
    let mut first = String::new();
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => reply_tool(
                    "bash",
                    json!({
                    "command":"printf %s $$ > first.pid; printf first; exec /bin/sleep 20",
                        "background":true, "timeoutMs":9000,
                    }),
                ),
                2 => {
                    let startup = model_result(request);
                    assert_eq!(startup["output"]["status"], "running");
                    first = startup["output"]["taskId"].as_str().unwrap().to_owned();
                    assert!(peer_protocol::shell_task_id_valid(&first));
                    assert!(!group_absent(recorded_pid(&work.join("first.pid"))));
                    reply_tool(
                        "bash",
                        json!({
                        "command":"printf %s $$ > second.pid; printf second; exec /bin/sleep 20",
                            "background":true, "timeoutMs":9000,
                        }),
                    )
                }
                3 => {
                    let startup = model_result(request);
                    let second = startup["output"]["taskId"].as_str().unwrap();
                    assert_ne!(first, second);
                    assert!(!group_absent(recorded_pid(&work.join("second.pid"))));
                    reply_tool(
                        "shell_stop",
                        json!({"taskId":first,"reason":"controlled stop"}),
                    )
                }
                4 => {
                    let result = model_result(request);
                    assert_eq!(result["output"]["taskId"], first);
                    assert_eq!(result["output"]["stopped"], true);
                    assert_eq!(result["output"]["reason"], "controlled stop");
                    assert!(group_absent(recorded_pid(&work.join("first.pid"))));
                    assert!(!group_absent(recorded_pid(&work.join("second.pid"))));
                    reply_tool("shell_stop", json!({"taskId":first}))
                }
                5 => {
                    let result = model_result(request);
                    assert_eq!(result["output"]["taskId"], first);
                    assert_eq!(result["output"]["stopped"], false);
                    assert_eq!(result["output"]["reason"], "already_ended");
                    reply_tool(
                        "shell_stop",
                        json!({"taskId":"shell_00000000-0000-0000-0000-000000000000"}),
                    )
                }
                6 => {
                    let result = model_result(request);
                    assert_eq!(result["output"]["found"], false);
                    assert!(!group_absent(recorded_pid(&work.join("second.pid"))));
                    reply_text("Observed real shutdown.")
                }
                _ => panic!("unexpected model request"),
            }
        },
        false,
        false,
        vec![],
    );
    let out = fixture.run(
        Some(&server),
        &[
            "--tools",
            "bash,shell_stop",
            "--access",
            "full",
            "--output-format",
            "json",
            "Exercise controlled background commands",
        ],
        None,
    );
    assert!(
        out.status.success(),
        "stdout={} stderr={} requests={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
        server.requests.lock().unwrap().len()
    );
    let reply = fixture.assert_settled(&out, 6, 5);
    for name in ["first", "second"] {
        assert!(group_absent(recorded_pid(
            &fixture.workspace().join(format!("{name}.pid"))
        )));
    }
    let id = reply["sessionId"].as_str().unwrap();
    let history = ConversationStore::new(fixture.home())
        .read_committed(id, None, 8 * 1024 * 1024)
        .unwrap();
    let tools: Vec<_> = history
        .history
        .messages
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .filter(|segment| segment["type"] == "tool-call")
        .collect();
    for (segment, bytes) in tools[..2]
        .iter()
        .zip([b"first".as_slice(), b"second".as_slice()])
    {
        let result = &segment["result"];
        assert_eq!(result["output"]["status"], "running");
        assert_eq!(result["evidence"]["nativeProcess"]["state"], "running");
        let dir = artifacts(
            &fixture.home(),
            result["output"]["taskId"].as_str().unwrap(),
        );
        let metadata = get(dir.join("metadata.json"));
        assert_eq!(metadata["managedProcessEnded"], true);
        assert_eq!(metadata["status"], "cancelled");
        assert_eq!(fs::read(dir.join("stdout.txt")).unwrap(), bytes);
    }
    assert_eq!(tools[2]["result"]["capabilityId"], "local.shell.stop");
    assert_eq!(
        tools[2]["result"]["evidence"]["artifactRefs"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(tools[4]["result"]["error"]["code"], "shell_task_not_found");
}

#[test]
fn public_shell_background_archive_can_settle_from_the_original_running_receipt() {
    let fixture = Ordinary::new();
    let command = format!(
        "printf %s $$ > archived.pid; printf archived; # {}",
        "x".repeat(7000)
    );
    let server = Server::new(vec![
        reply_tool("bash", json!({"command":command,"background":true})),
        reply_text("Observed launch."),
    ]);
    let out = fixture.run(
        Some(&server),
        &[
            "--tools",
            "bash",
            "--access",
            "full",
            "--output-format",
            "json",
            "Archive startup",
        ],
        None,
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let reply = fixture.assert_settled(&out, 2, 1);
    let history = ConversationStore::new(fixture.home())
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let startup = history
        .history
        .messages
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .find(|segment| segment["type"] == "tool-call")
        .unwrap();
    assert!(startup["result"]["output"]["nativeContentRef"].is_object());
    let process = &startup["result"]["evidence"]["nativeProcess"];
    assert_eq!(process["state"], "running");
    let sent = model_result(&server.requests.lock().unwrap()[1]);
    assert_eq!(sent["taskId"], process["handleId"]);
    assert_eq!(sent["status"], "running");
    let pid = process["child"]["pid"].as_u64().unwrap() as u32;
    assert!(group_absent(pid));
    let dir = artifacts(&fixture.home(), process["handleId"].as_str().unwrap());
    assert_eq!(get(dir.join("metadata.json"))["managedProcessEnded"], true);
}

#[test]
fn public_shell_background_reports_natural_exit_and_timeout_as_ended() {
    for (command, timeout, status) in [
        ("printf natural", 9000, "completed"),
        ("exec /bin/sleep 10", 450, "timeout"),
    ] {
        let fixture = Ordinary::new();
        let home = fixture.home();
        let mut turn = 0;
        let server = Server::scripted(
            move |request| {
                turn += 1;
                match turn {
                    1 => reply_tool(
                        "bash",
                        json!({"command":command,"background":true,"timeoutMs":timeout}),
                    ),
                    2 => {
                        let launch = model_result(request);
                        let handle = launch["output"]["taskId"].as_str().unwrap();
                        let metadata = artifacts(&home, handle).join("metadata.json");
                        let deadline = Instant::now() + Duration::from_secs(3);
                        loop {
                            let saved = fs::read(&metadata)
                                .ok()
                                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                            if saved.is_some_and(|row| row["managedProcessEnded"] == true) {
                                break;
                            }
                            assert!(Instant::now() < deadline, "background process never ended");
                            thread::sleep(Duration::from_millis(5));
                        }
                        reply_tool("shell_stop", json!({"taskId":handle}))
                    }
                    3 => {
                        let result = model_result(request);
                        assert_eq!(result["output"]["stopped"], false);
                        assert_eq!(result["output"]["status"], status);
                        reply_text("Observed terminal status.")
                    }
                    _ => panic!("unexpected cognition"),
                }
            },
            false,
            false,
            vec![],
        );
        let out = fixture.run(
            Some(&server),
            &[
                "--tools",
                "bash,shell_stop",
                "--access",
                "full",
                "--output-format",
                "json",
                "Observe bounded shell termination",
            ],
            None,
        );
        assert!(
            out.status.success(),
            "{} {}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        fixture.assert_settled(&out, 3, 2);
    }
}

#[test]
fn public_shell_background_permission_denial_creates_no_child_or_artifact() {
    let fixture = Ordinary::new();
    let hooks = fixture.workspace().join(".peer");
    fs::create_dir_all(&hooks).unwrap();
    fs::write(
        hooks.join("hooks.json"),
        json!({"hooks":{"PreToolUse":[
            {"id":"deny-shell","command":r#"printf '%s' '{"decision":"deny"}'"#}
        ]}})
        .to_string(),
    )
    .unwrap();
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf forbidden > denied","background":true}),
        ),
        reply_text("Observed denial."),
    ]);
    let out = fixture.run(
        Some(&server),
        &[
            "--tools",
            "bash",
            "--access",
            "full",
            "--output-format",
            "json",
            "Do not grant",
        ],
        None,
    );
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fixture.assert_settled(&out, 2, 1);
    let sent = model_result(&server.requests.lock().unwrap()[1]);
    assert_eq!(sent["status"], "denied");
    assert_eq!(sent["error"]["code"], "hook_denied");
    assert!(!fixture.workspace().join("denied").exists());
    assert!(!fixture.home().join("shell-artifacts").exists());
}
