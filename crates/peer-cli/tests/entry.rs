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
    for args in [&["--version"][..], &["--help"][..]] {
        let result = run(args);
        assert!(result.status.success(), "{:?}", result);
        assert!(!result.stdout.contains(&0x1b));
        assert!(result.stderr.is_empty());
    }
    let result = run(&["doctor"]);
    assert_eq!(result.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&result.stdout).contains("data root: failed"));
    assert!(!result.stdout.contains(&0x1b));
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
            .arg("sessions")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env(variable, root.path())
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            output.stderr, b"No sessions.\n",
            "override {variable} must precede HOME lookup"
        );
        assert!(std::fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
