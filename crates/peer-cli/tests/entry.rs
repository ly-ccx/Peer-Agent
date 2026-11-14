use std::process::{Command, Stdio};

fn run(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_peer-native"))
        .args(args)
        .env_clear()
        .env("PATH", "/nonexistent")
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

#[test]
fn lightweight_entries_run_without_js_or_home_and_do_not_emit_terminal_sequences() {
    for args in [&["--version"][..], &["--help"][..], &["doctor"][..]] {
        let result = run(args);
        assert!(result.status.success(), "{:?}", result);
        assert!(!result.stdout.contains(&0x1b));
        assert!(result.stderr.is_empty());
    }
    let result = run(&["doctor"]);
    let facts: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(facts["sidecar"], false);
    assert_eq!(facts["runtimeConnected"], true);
    assert_eq!(facts["dataHomeConfigured"], false);
}

#[test]
fn non_tty_and_unsupported_execution_fail_without_creating_personal_state() {
    assert_eq!(run(&[]).status.code(), Some(2));
    for args in [&["exec", "hello"][..], &["acp"][..], &["sessions"][..]] {
        let result = run(args);
        assert_eq!(result.status.code(), Some(1));
        assert!(result.stdout.is_empty());
    }
}

#[test]
fn explicit_data_home_is_resolved_without_home_and_discovery_never_writes() {
    let root = tempfile::tempdir().unwrap();
    for variable in ["PEER_AGENT_HOME", "PEER_USER_DATA_PATH"] {
        let output = Command::new(env!("CARGO_BIN_EXE_peer-native"))
            .arg("doctor")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env(variable, root.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        let facts: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            facts["dataHomeConfigured"], true,
            "override {variable} must precede HOME lookup"
        );
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
