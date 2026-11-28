use peer_core_rpc::{
    CoreServerConfig, DaemonClient, DaemonDescriptor, DaemonOptions, ExternalCapabilityManifest,
    PROTOCOL_VERSION, RawDaemonConnection, daemon_descriptor_path, serve_daemon,
};
use peer_runtime::CancellationToken;
use serde_json::{Value, json};
use std::{fs, io, path::Path, time::Duration};
use tempfile::tempdir;

async fn start_test_daemon(
    data_home: &Path,
) -> (
    DaemonDescriptor,
    CancellationToken,
    tokio::task::JoinHandle<io::Result<()>>,
) {
    let config = CoreServerConfig::new("0.1.0-test", data_home.to_path_buf());
    let shutdown = CancellationToken::new();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let server_cancel = shutdown.clone();
    let handle = tokio::spawn(serve_daemon(
        config,
        DaemonOptions::default(),
        server_cancel,
        Some(Box::new(move |desc| {
            let _ = tx.send(desc.clone());
        })),
    ));
    let descriptor = tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .expect("daemon ready timeout")
        .expect("daemon exited before ready");
    (descriptor, shutdown, handle)
}

#[tokio::test]
async fn daemon_permissions_and_auth_enforcement() {
    let home = tempdir().expect("tempdir");
    let (desc, _shutdown, handle) = start_test_daemon(home.path()).await;

    let desc_path = daemon_descriptor_path(home.path());
    assert!(desc_path.is_file(), "core-daemon.json should exist");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let desc_mode = fs::metadata(&desc_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(desc_mode, 0o600, "core-daemon.json must be 0600");
        let sock_mode = fs::metadata(&desc.endpoint).unwrap().permissions().mode() & 0o777;
        assert_eq!(sock_mode, 0o600, "daemon unix socket must be 0600");
    }

    let mut raw = RawDaemonConnection::connect(&desc.endpoint, &desc.transport)
        .await
        .expect("raw connect");

    let uninit_ping = raw
        .send_raw_request("core.ping", json!({}), Duration::from_secs(2))
        .await
        .expect("frame ok")
        .unwrap_err();
    assert_eq!(uninit_ping.code, -32001);

    let uninit_shutdown = raw
        .send_raw_request(
            "core.shutdown",
            json!({ "shutdownDaemon": true }),
            Duration::from_secs(2),
        )
        .await
        .expect("frame ok")
        .unwrap_err();
    assert_eq!(uninit_shutdown.code, -32001);

    let missing_auth = raw
        .send_raw_request(
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "rogue", "version": "1.0.0" },
            }),
            Duration::from_secs(2),
        )
        .await
        .expect("frame ok")
        .unwrap_err();
    assert_eq!(missing_auth.code, -32005);

    let wrong_auth = raw
        .send_raw_request(
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "rogue", "version": "1.0.0" },
                "authToken": "definitely-wrong-token",
            }),
            Duration::from_secs(2),
        )
        .await
        .expect("frame ok")
        .unwrap_err();
    assert_eq!(wrong_auth.code, -32005);
    raw.finish().await;

    let client = DaemonClient::connect_data_home(home.path(), "peer-cli", "0.1.0-test", vec![])
        .await
        .expect("authorized client connect");
    let stop_res = client.shutdown_daemon().await.expect("shutdown daemon");
    assert_eq!(stop_res["daemonShutdown"], true);

    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("daemon join timeout")
        .expect("daemon task ok")
        .expect("daemon serve ok");

    assert!(!desc_path.exists(), "core-daemon.json should be removed");
    #[cfg(unix)]
    assert!(
        !Path::new(&desc.endpoint).exists(),
        "unix socket should be removed on clean shutdown"
    );
}

#[tokio::test]
async fn daemon_shared_project_host_capability_scoping_and_shutdown_if_last() {
    let home = tempdir().expect("temp home");
    let ws_dir = tempdir().expect("temp ws");
    fs::write(ws_dir.path().join("README.md"), "# Shared Daemon Repo\n").unwrap();

    let (desc, _shutdown, handle) = start_test_daemon(home.path()).await;

    let desktop_caps = vec![ExternalCapabilityManifest {
        alias: "desktop_echo".to_owned(),
        capability_id: "local.web.control.echo".to_owned(),
        manifest: json!({
            "capabilityId": "local.web.control.echo",
            "description": "Echo from desktop",
            "riskLevel": "read_only",
            "inputSchema": { "type": "object", "properties": {} },
        }),
    }];
    let mut desktop =
        DaemonClient::connect_descriptor(&desc, "peer-desktop", "0.1.0-test", desktop_caps)
            .await
            .expect("desktop connect");

    let created = desktop
        .request(
            "project.bot.create",
            json!({
                "workspacePath": ws_dir.path().to_string_lossy(),
                "startFamiliarize": false,
            }),
        )
        .await
        .unwrap()
        .expect("project.bot.create");
    assert_eq!(created["ok"], true);
    let workspace_id = created["profile"]["workspaceId"]
        .as_str()
        .expect("workspaceId")
        .to_owned();

    let cfg = desktop
        .request("project.bot.hostConfigure", json!({ "enabled": true }))
        .await
        .unwrap()
        .expect("project.bot.hostConfigure");
    assert_eq!(cfg["enabled"], true);
    assert!(
        cfg["ownedWorkspaces"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str() == Some(workspace_id.as_str())),
        "expected daemon to own workspace lease: {cfg}"
    );

    let mut cli = DaemonClient::connect_data_home(home.path(), "peer-cli", "0.1.0-test", vec![])
        .await
        .expect("cli connect");

    let daemon_status = cli
        .request("core.daemon.status", json!({}))
        .await
        .unwrap()
        .expect("core.daemon.status");
    assert_eq!(daemon_status["daemon"], true);
    assert_eq!(daemon_status["connectedClients"], 2);
    assert_eq!(daemon_status["initializedClients"], 2);
    assert_eq!(daemon_status["projectBotHostEnabled"], true);

    let bot_list = cli
        .request("project.bot.list", json!({}))
        .await
        .unwrap()
        .expect("project.bot.list");
    assert_eq!(bot_list["ok"], true);
    assert_eq!(bot_list["items"].as_array().unwrap().len(), 1);

    let host_status = cli
        .request("project.bot.hostStatus", json!({}))
        .await
        .unwrap()
        .expect("project.bot.hostStatus");
    assert_eq!(host_status["enabled"], true);

    let wake_res = cli
        .request("project.bot.wake", json!({ "workspaceId": workspace_id }))
        .await
        .unwrap()
        .expect("project.bot.wake");
    assert_eq!(wake_res["ok"], true);
    assert_eq!(wake_res["woken"], true);

    let caps_with_desktop = cli
        .request("core.capabilities.list", json!({}))
        .await
        .unwrap()
        .expect("core.capabilities.list");
    assert!(
        caps_with_desktop["externalCapabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["alias"] == "desktop_echo"),
        "expected desktop_echo while desktop is connected: {caps_with_desktop}"
    );

    let submitted = desktop
        .request(
            "project.bot.submitInput",
            json!({
                "workspaceId": workspace_id,
                "surface": "desktop",
                "text": "hello shared daemon",
            }),
        )
        .await
        .unwrap()
        .expect("project.bot.submitInput");
    assert_eq!(submitted["ok"], true);

    let cli_notice = cli
        .next_notification(Duration::from_secs(2))
        .await
        .expect("poll cli notification");
    assert!(
        cli_notice.is_some(),
        "expected CLI client to receive pushed project.bot.* notification"
    );

    // Desktop leaves with shutdownIfLast: true -> CLI still connected, so daemon stays alive.
    let desktop_leave = desktop
        .shutdown_if_last()
        .await
        .expect("desktop shutdownIfLast");
    assert_eq!(desktop_leave["disconnected"], true);
    assert_eq!(desktop_leave["daemonShutdown"], false);
    assert_eq!(desktop_leave["remainingClients"], 1);

    // Give disconnect unregister a moment to finish cleanly.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let ping_after = cli
        .request("core.ping", json!({}))
        .await
        .unwrap()
        .expect("cli ping");
    assert_eq!(ping_after["ok"], true);

    // Desktop-only capability auto-unloaded when Desktop disconnected.
    let caps_after = cli
        .request("core.capabilities.list", json!({}))
        .await
        .unwrap()
        .expect("core.capabilities.list");
    assert_eq!(
        caps_after["externalCapabilities"].as_array().unwrap().len(),
        0,
        "desktop capabilities should unload on disconnect: {caps_after}"
    );

    // Last client leaves with shutdownIfLast: true -> daemon shuts down and releases leases.
    let cli_leave = cli.shutdown_if_last().await.expect("cli shutdownIfLast");
    assert_eq!(cli_leave["disconnected"], true);
    assert_eq!(cli_leave["daemonShutdown"], true);
    assert_eq!(cli_leave["remainingClients"], 0);

    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("daemon join")
        .expect("join ok")
        .expect("daemon exit ok");

    let lease_path = home
        .path()
        .join("project-runtime")
        .join(&workspace_id)
        .join("host.lease");
    if lease_path.is_file() {
        let raw_lease = fs::read_to_string(&lease_path).unwrap_or_default();
        let parsed: Value = serde_json::from_str(&raw_lease).unwrap_or(Value::Null);
        assert!(
            parsed.is_null() || parsed.get("hostId").is_none(),
            "lease should be released on daemon shutdown: {raw_lease}"
        );
    }
    assert!(!daemon_descriptor_path(home.path()).exists());
}

#[tokio::test]
async fn daemon_recovers_from_stale_descriptor() {
    let home = tempdir().expect("temp home");
    let stale_desc = json!({
        "version": 1,
        "pid": 99_999_999_u32,
        "serverVersion": "0.0.0-stale",
        "transport": if cfg!(windows) { "named_pipe" } else { "unix" },
        "endpoint": if cfg!(windows) { r"\\.\pipe\peer-stale-nonexistent" } else { "/tmp/peer-stale-nonexistent.sock" },
        "authToken": "stale-token",
        "startedAt": "2020-01-01T00:00:00.000Z"
    });
    fs::write(
        daemon_descriptor_path(home.path()),
        serde_json::to_vec(&stale_desc).unwrap(),
    )
    .unwrap();

    let (desc, _shutdown, handle) = start_test_daemon(home.path()).await;
    assert_ne!(desc.auth_token, "stale-token");
    assert_eq!(desc.pid, std::process::id());

    let mut client = DaemonClient::connect_descriptor(&desc, "peer-cli", "0.1.0-test", vec![])
        .await
        .expect("connect recovered daemon");
    let pong = client
        .request("core.ping", json!({}))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pong["ok"], true);
    client.shutdown_daemon().await.unwrap();

    tokio::time::timeout(Duration::from_secs(5), handle)
        .await
        .expect("join")
        .expect("task")
        .expect("serve ok");
}
