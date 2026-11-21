//! Public shell entry vs actual TS scripts/parser, without HOME, JS or a TTY.
use serde_json::Value;
use std::{
    io::Write,
    process::{Command, Stdio},
};
fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/shell-completions.json"
    ))
    .unwrap()
}
fn binary() -> std::path::PathBuf {
    let path = std::env::var_os("PEER_NATIVE_TEST_BINARY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_peer-native").into());
    assert!(path.is_absolute() && path.is_file());
    path
}
#[test]
fn completion_scripts_help_and_usage_match_actual_ts_and_never_create_data() {
    let data = contract();
    let root = tempfile::tempdir().unwrap();
    for case in data["cases"].as_array().unwrap() {
        let argv = case["argv"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect::<Vec<_>>();
        let out = Command::new(binary())
            .args(&argv)
            .env_clear()
            .env("PATH", "/nonexistent")
            .current_dir(root.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let expected = &case["expected"];
        if expected["kind"] == "error" {
            assert_eq!(
                out.status.code(),
                expected["exitCode"].as_i64().map(|v| v as i32),
                "{argv:?}"
            );
            assert!(out.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&out.stderr)
                    .contains(expected["message"].as_str().unwrap())
            );
        } else {
            assert!(
                out.status.success(),
                "{argv:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(out.stderr.is_empty());
            let expected = match expected["kind"].as_str().unwrap() {
                "completions" => data["scripts"][expected["shell"].as_str().unwrap()]
                    .as_str()
                    .unwrap()
                    .to_owned(),
                "help" => format!("{}\n", data["help"].as_str().unwrap()),
                "version" => format!("peer {}\n", peer_cli::VERSION.trim()),
                other => panic!("unexpected fixture kind {other}"),
            };
            assert_eq!(String::from_utf8(out.stdout).unwrap(), expected, "{argv:?}");
        }
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
#[cfg(unix)]
#[test]
fn printed_bash_completion_actually_completes_models_and_session_actions() {
    let out = Command::new(binary())
        .args(["completions", "bash"])
        .env_clear()
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert!(out.status.success());
    let mut child = Command::new("/bin/bash")
        .args(["--noprofile", "--norc"])
        .env_clear()
        .env("PATH", "/nonexistent")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(&out.stdout).unwrap();
    input.write_all(b"\nCOMP_WORDS=(peer mo); COMP_CWORD=1; _peer; printf '%s\\n' \"${COMPREPLY[@]}\"\nCOMP_WORDS=(peer sessions re); COMP_CWORD=2; _peer; printf '%s\\n' \"${COMPREPLY[@]}\"\n").unwrap();
    drop(input);
    let result = child.wait_with_output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(
        String::from_utf8(result.stdout).unwrap(),
        "models\nresume\n"
    );
    assert!(result.stderr.is_empty());
}
