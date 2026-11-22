use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};
use tempfile::tempdir;

#[test]
fn peer_native_core_daemon_lifecycle_and_shared_bots_list() {
    let bin = env!("CARGO_BIN_EXE_peer-native");
    let home = tempdir().expect("tempdir");

    let mut daemon = Command::new(bin)
        .args(["core", "--daemon"])
        .env("PEER_AGENT_HOME", home.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn peer-native core --daemon");

    let stdout = daemon.stdout.take().expect("daemon stdout");
    let mut reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    let n = reader.read_line(&mut ready_line).expect("read ready line");
    assert!(n > 0, "daemon exited without printing ready line");
    let ready: Value = serde_json::from_str(ready_line.trim()).expect("ready json");
    assert_eq!(ready["ok"], true);
    assert_eq!(ready["daemon"], true);
    assert!(
        ready.get("authToken").is_none(),
        "stdout must never print authToken: {ready}"
    );
    let daemon_pid = ready["pid"].as_u64().expect("pid");
    let endpoint = ready["endpoint"].as_str().expect("endpoint").to_owned();

    let desc_path = home.path().join("core-daemon.json");
    assert!(desc_path.is_file(), "core-daemon.json should exist");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let desc_mode = fs::metadata(&desc_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(desc_mode, 0o600);
        let sock_mode = fs::metadata(&endpoint).unwrap().permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o600);
    }

    let status_out = Command::new(bin)
        .args(["core", "status", "--json"])
        .env("PEER_AGENT_HOME", home.path())
        .output()
        .expect("run peer core status --json");
    assert!(
        status_out.status.success(),
        "status failed: {}",
        String::from_utf8_lossy(&status_out.stderr)
    );
    let status_json: Value = serde_json::from_slice(&status_out.stdout).expect("parse status json");
    assert_eq!(status_json["running"], true);
    assert_eq!(status_json["pid"], daemon_pid);

    let bots_out = Command::new(bin)
        .args(["bots", "--json"])
        .env("PEER_AGENT_HOME", home.path())
        .output()
        .expect("run peer bots --json via daemon");
    assert!(
        bots_out.status.success(),
        "bots --json failed: {}",
        String::from_utf8_lossy(&bots_out.stderr)
    );
    let bots_json: Value = serde_json::from_slice(&bots_out.stdout).expect("parse bots json");
    assert!(bots_json.is_array(), "bots --json must output an array");

    let standalone_out = Command::new(bin)
        .args(["bots", "--json", "--standalone"])
        .env("PEER_AGENT_HOME", home.path())
        .output()
        .expect("run peer bots --json --standalone");
    assert!(standalone_out.status.success());
    let standalone_json: Value =
        serde_json::from_slice(&standalone_out.stdout).expect("parse standalone json");
    assert!(standalone_json.is_array());

    let stop_out = Command::new(bin)
        .args(["core", "stop"])
        .env("PEER_AGENT_HOME", home.path())
        .output()
        .expect("run peer core stop");
    assert!(
        stop_out.status.success(),
        "stop failed: {}",
        String::from_utf8_lossy(&stop_out.stderr)
    );

    let wait_deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(exit_status) = daemon.try_wait().expect("try_wait") {
            assert!(
                exit_status.success(),
                "daemon exited non-zero: {exit_status:?}"
            );
            break;
        }
        assert!(
            std::time::Instant::now() < wait_deadline,
            "daemon did not exit after peer core stop"
        );
        std::thread::sleep(Duration::from_millis(25));
    }

    assert!(!desc_path.exists(), "core-daemon.json should be cleaned up");
    #[cfg(unix)]
    assert!(
        !Path::new(&endpoint).exists(),
        "unix socket should be cleaned up"
    );

    let stopped_out = Command::new(bin)
        .args(["core", "status", "--json"])
        .env("PEER_AGENT_HOME", home.path())
        .output()
        .expect("run peer core status --json after stop");
    assert!(stopped_out.status.success());
    let stopped_json: Value =
        serde_json::from_slice(&stopped_out.stdout).expect("parse stopped json");
    assert_eq!(stopped_json["running"], false);
}
