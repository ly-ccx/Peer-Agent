use serde_json::{Value, json};
#[cfg(unix)]
#[path = "session_shell/export_interrupts.rs"]
mod export_interrupts;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
fn binary() -> PathBuf {
    std::env::var_os("PEER_NATIVE_TEST_BINARY")
        .map(PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_peer-native").into())
}
fn run(home: &Path, args: &[&str]) -> std::process::Output {
    Command::new(binary())
        .args(args)
        .env_clear()
        .env("PATH", "/nonexistent")
        .env("PEER_AGENT_HOME", home)
        .current_dir(home.ancestors().find(|p| p.is_dir()).unwrap())
        .stdin(Stdio::null())
        .output()
        .unwrap()
}
#[test]
fn existing_ts_parser_and_help_contracts_are_preserved() {
    let data = contract();
    let root = tempfile::tempdir().unwrap();
    for case in data["argv"].as_array().unwrap() {
        let args = case["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let expected = &case["expected"];
        let parsed = peer_cli::command(&args);
        match expected["kind"].as_str().unwrap() {
            "doctor" => assert_eq!(parsed, peer_cli::Command::Doctor),
            "sessions" => assert_eq!(parsed, peer_cli::Command::SessionsList),
            "export" => {
                let peer_cli::Command::Export(options) = parsed else {
                    panic!("{args:?}")
                };
                assert_eq!(options.session_id, expected["sessionId"]);
                assert_eq!(
                    options.output_path.as_deref(),
                    expected["outputPath"].as_str()
                );
                assert_eq!(options.force, expected["force"].as_bool().unwrap());
            }
            "help" => {
                let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
                let out = run(root.path(), &borrowed);
                assert!(out.status.success());
                assert!(out.stderr.is_empty());
                assert_eq!(
                    String::from_utf8(out.stdout).unwrap(),
                    format!(
                        "{}\n",
                        data["help"][expected["topic"].as_str().unwrap()]
                            .as_str()
                            .unwrap()
                    )
                );
            }
            "error" => {
                let peer_cli::Command::Usage(message) = parsed else {
                    panic!("{args:?}")
                };
                assert_eq!(message, expected["message"]);
                let borrowed = args.iter().map(String::as_str).collect::<Vec<_>>();
                let out = run(root.path(), &borrowed);
                assert_eq!(out.status.code(), Some(2));
                assert!(out.stdout.is_empty());
            }
            other => panic!("unexpected contract {other}"),
        }
    }
}
fn export_fixture(root: &Path, v: &Value) {
    let dir = root.join("conversations");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("index.jsonl"),
        v["index"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| format!("{r}\n"))
            .collect::<String>(),
    )
    .unwrap();
    std::fs::write(
        dir.join("a.jsonl"),
        v["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| format!("{r}\n"))
            .collect::<String>(),
    )
    .unwrap();
    if let Some(sidecar) = v.get("sidecar") {
        std::fs::write(dir.join("a.stream.json"), sidecar.to_string()).unwrap();
    }
}
#[test]
fn public_native_export_matches_real_ts_visible_stream_and_markdown_without_source_changes() {
    for v in contract()["cases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        export_fixture(root.path(), v);
        let body = root.path().join("conversations/a.jsonl");
        let index = root.path().join("conversations/index.jsonl");
        let before = (
            std::fs::read(&body).unwrap(),
            std::fs::read(&index).unwrap(),
        );
        let out = run(root.path(), &["export", "a"]);
        if let Some(expected) = v["expectedMarkdown"].as_str() {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(String::from_utf8(out.stdout).unwrap(), expected);
            assert!(out.stderr.is_empty());
        } else {
            assert_eq!(out.status.code(), Some(1));
            assert!(out.stdout.is_empty());
        }
        assert_eq!(
            (std::fs::read(body).unwrap(), std::fs::read(index).unwrap()),
            before
        );
    }
}
#[test]
fn output_refuses_clobber_and_store_aliases_and_force_publishes_a_complete_reading_copy() {
    let root = tempfile::tempdir().unwrap();
    let data = contract();
    let v = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "visible-content")
        .unwrap();
    export_fixture(root.path(), v);
    let file = root.path().join("copy.md");
    std::fs::write(&file, b"earlier copy").unwrap();
    let path = file.to_str().unwrap();
    let out = run(root.path(), &["export", "a", "--output", path]);
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(std::fs::read(&file).unwrap(), b"earlier copy");
    let out = run(root.path(), &["export", "a", "--output", path, "--force"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        v["expectedMarkdown"]
    );
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("Exported a to "));
    let source = root.path().join("conversations/a.jsonl");
    let before = std::fs::read(&source).unwrap();
    let out = run(
        root.path(),
        &[
            "export",
            "a",
            "--output",
            source.to_str().unwrap(),
            "--force",
        ],
    );
    assert!(!out.status.success());
    assert_eq!(std::fs::read(&source).unwrap(), before);
    let alias = root.path().join("alias.md");
    std::fs::hard_link(&source, &alias).unwrap();
    let out = run(
        root.path(),
        &[
            "export",
            "a",
            "--output",
            alias.to_str().unwrap(),
            "--force",
        ],
    );
    assert!(!out.status.success());
    assert_eq!(std::fs::read(&source).unwrap(), before);
    #[cfg(unix)]
    {
        let link = root.path().join("link.md");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(
            !run(
                root.path(),
                &["export", "a", "--output", link.to_str().unwrap(), "--force"]
            )
            .status
            .success()
        );
        assert_eq!(std::fs::read(&source).unwrap(), before);
    }
}
#[test]
fn corrupt_streams_and_unsafe_terminal_text_leave_old_output_and_support_explicit_recovery() {
    let root = tempfile::tempdir().unwrap();
    let data = contract();
    let v = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["name"] == "stream-patch")
        .unwrap();
    export_fixture(root.path(), v);
    let output = root.path().join("out.md");
    std::fs::write(&output, b"keep me").unwrap();
    let sidecar = root.path().join("conversations/a.stream.json");
    for marker in [
        json!({"version":99}),
        json!({"version":1,"conversationId":"foreign","messageId":"m","patch":{}}),
        json!({"version":1,"conversationId":"a","messageId":"missing","patch":{"content":"late"}}),
    ] {
        std::fs::write(&sidecar, marker.to_string()).unwrap();
        let out = run(
            root.path(),
            &[
                "export",
                "a",
                "--output",
                output.to_str().unwrap(),
                "--force",
            ],
        );
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert_eq!(std::fs::read(&output).unwrap(), b"keep me");
        assert_eq!(
            std::fs::read_to_string(&sidecar).unwrap(),
            marker.to_string()
        );
    }
    std::fs::write(&sidecar,json!({"version":1,"conversationId":"a","messageId":"m","patch":{"content":"ESC \u{1b}]52;untrusted"}}).to_string()).unwrap();
    let out = run(root.path(), &["export", "a"]);
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(!out.stderr.contains(&0x1b));
    let out = run(
        root.path(),
        &[
            "export",
            "a",
            "--output",
            output.to_str().unwrap(),
            "--force",
        ],
    );
    assert!(out.status.success());
    assert!(std::fs::read(&output).unwrap().contains(&0x1b));
    std::fs::write(&sidecar, v["sidecar"].to_string()).unwrap();
    assert!(run(root.path(), &["export", "a"]).status.success());
}
fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/session-shell.json"
    ))
    .unwrap()
}
fn fixture(root: &Path, v: &Value) {
    let dir = root.join("conversations");
    std::fs::create_dir_all(&dir).unwrap();
    let rows = v["index"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| format!("{r}\n"))
        .collect::<String>();
    std::fs::write(dir.join("index.jsonl"), rows).unwrap();
    std::fs::create_dir(dir.join("a.jsonl")).unwrap();
}
#[test]
fn session_list_matches_actual_ts_store_and_never_reads_or_repairs_the_body() {
    for v in contract()["cases"].as_array().unwrap() {
        let root = tempfile::tempdir().unwrap();
        fixture(root.path(), v);
        let file = root.path().join("conversations/index.jsonl");
        let before = std::fs::read(&file).unwrap();
        for args in [vec!["sessions"], vec!["sessions", "list"]] {
            let out = run(root.path(), &args);
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let expected = &v["expectedList"];
            let stdout = expected["stdout"].as_array().unwrap();
            let stderr = expected["stderr"].as_array().unwrap();
            let lines = |values: &Vec<Value>| {
                if values.is_empty() {
                    String::new()
                } else {
                    values
                        .iter()
                        .map(|s| format!("{}\n", s.as_str().unwrap()))
                        .collect()
                }
            };
            assert_eq!(String::from_utf8(out.stdout).unwrap(), lines(stdout));
            assert_eq!(String::from_utf8(out.stderr).unwrap(), lines(stderr));
            assert_eq!(std::fs::read(&file).unwrap(), before);
            assert_eq!(
                std::fs::read_dir(root.path().join("conversations"))
                    .unwrap()
                    .count(),
                2
            );
        }
    }
}
#[test]
fn empty_and_bad_session_indexes_remain_unchanged_and_a_repaired_source_lists_again() {
    let root = tempfile::tempdir().unwrap();
    let missing = root.path().join("not-created");
    let out = run(&missing, &["sessions"]);
    assert!(out.status.success());
    assert_eq!(out.stderr, b"No sessions.\n");
    assert!(!missing.exists());
    let dir = root.path().join("conversations");
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("index.jsonl");
    for bytes in [
        b"{broken\n".to_vec(),
        format!("{}\n{}\n", json!({"id":"a"}), json!({"id":"a"})).into_bytes(),
        b"{\"id\":\"../outside\"}\n".to_vec(),
        b"{\"id\":\"a\",\"title\":\"\\u001b]52;forged\"}\n".to_vec(),
    ] {
        std::fs::write(&file, &bytes).unwrap();
        let out = run(root.path(), &["sessions"]);
        assert!(!out.status.success());
        assert!(out.stdout.is_empty());
        assert!(!out.stderr.contains(&0x1b));
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }
    std::fs::write(&file, b"{\"id\":\"a\",\"title\":\"repaired\"}\n").unwrap();
    assert!(run(root.path(), &["sessions"]).status.success());
}
#[cfg(unix)]
#[test]
fn doctor_checks_the_actual_bundle_and_readonly_data_root_without_running_the_helper() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    let peer = root.path().join("peer");
    std::fs::copy(binary(), &peer).unwrap();
    let helper = root.path().join("peer-credential-helper");
    let marker = root.path().join("helper-was-run");
    std::fs::write(
        &helper,
        "#!/bin/sh\nprintf ran > \"$PEER_DOCTOR_SENTINEL\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    let data = root.path().join("not-created/nested");
    let inspect = || {
        Command::new(&peer)
            .arg("doctor")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("PEER_AGENT_HOME", &data)
            .env("PEER_DOCTOR_SENTINEL", &marker)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    };
    let out = inspect();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.stderr.is_empty());
    assert!(String::from_utf8_lossy(&out.stdout).contains("credential helper: ok"));
    assert!(String::from_utf8_lossy(&out.stdout).contains("data root: ok"));
    assert!(!data.exists());
    assert!(!marker.exists());
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o600)).unwrap();
    let out = inspect();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("credential helper failed"));
    assert!(!marker.exists());
    std::fs::remove_file(&helper).unwrap();
    let out = inspect();
    assert_eq!(out.status.code(), Some(1));
    assert!(!data.exists());
    std::fs::write(&helper, b"metadata-only executable fixture").unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(root.path().join("not-created"), b"not a directory").unwrap();
    let out = inspect();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("data root failed"));
}
