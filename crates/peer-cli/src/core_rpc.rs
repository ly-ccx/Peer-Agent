//! Local Rust Core stdio & shared daemon JSON-RPC host entrypoints (`peer core ...`).

use peer_core_rpc::{
    CoreServerConfig, DaemonClient, DaemonOptions, DaemonReadyCallback, cleanup_stale_descriptor,
    daemon_descriptor_path, read_daemon_descriptor, serve_daemon, serve_stdio,
};
use peer_protocol::CliExit;
use serde_json::json;
use std::{
    io::{self, Write},
    path::PathBuf,
    time::Duration,
};

const DAEMON_CONTROL_TIMEOUT: Duration = Duration::from_secs(2);

pub fn run() -> io::Result<CliExit> {
    let data_home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let config = CoreServerConfig::new(crate::VERSION.trim(), data_home);
    let outcome = crate::cancellation::run(|cancel| async move {
        let server_cancel = cancel.clone();
        let result = serve_stdio(config, server_cancel).await;
        (result, cancel.is_cancelled())
    })?;
    match outcome {
        (Ok(()), _) => Ok(CliExit::Ok),
        (Err(error), true) if error.kind() == io::ErrorKind::Interrupted => Ok(CliExit::Cancelled),
        (Err(error), _) => Err(error),
    }
}

pub fn run_daemon(socket_override: Option<PathBuf>, quiet: bool) -> io::Result<CliExit> {
    let data_home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let config = CoreServerConfig::new(crate::VERSION.trim(), data_home);
    let on_ready: Option<DaemonReadyCallback> = if quiet {
        None
    } else {
        Some(Box::new(|desc| {
            let summary = json!({
                "ok": true,
                "daemon": true,
                "pid": desc.pid,
                "serverVersion": desc.server_version,
                "transport": desc.transport,
                "endpoint": desc.endpoint,
            });
            if let Ok(encoded) = serde_json::to_string(&summary) {
                let mut out = io::stdout().lock();
                let _ = writeln!(out, "{encoded}");
                let _ = out.flush();
            }
        }))
    };
    let outcome = crate::cancellation::run(|cancel| async move {
        let server_cancel = cancel.clone();
        let result = serve_daemon(
            config,
            DaemonOptions { socket_override },
            server_cancel,
            on_ready,
        )
        .await;
        (result, cancel.is_cancelled())
    })?;
    match outcome {
        (Ok(()), _) => Ok(CliExit::Ok),
        (Err(error), true) if error.kind() == io::ErrorKind::Interrupted => Ok(CliExit::Cancelled),
        (Err(error), _) => {
            writeln!(io::stderr(), "peer core --daemon: {error}")?;
            Ok(CliExit::Runtime)
        }
    }
}

pub fn run_status(json_out: bool) -> io::Result<CliExit> {
    let data_home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let descriptor = read_daemon_descriptor(&data_home).ok().flatten();
    let live_status = if let Some(desc) = &descriptor {
        crate::cancellation::run(|_| async move {
            tokio::time::timeout(DAEMON_CONTROL_TIMEOUT, async {
                let mut client = DaemonClient::connect_descriptor(
                    desc,
                    "peer-cli",
                    crate::VERSION.trim(),
                    vec![],
                )
                .await?;
                let res = client.request("core.daemon.status", json!({})).await?;
                let _ = client.disconnect().await;
                match res {
                    Ok(val) => Ok(val),
                    Err(err) => Err(io::Error::other(err.message)),
                }
            })
            .await
            .ok()
            .and_then(Result::ok)
        })?
    } else {
        None
    };

    if let Some(mut status_val) = live_status {
        if json_out {
            if let Some(obj) = status_val.as_object_mut() {
                obj.insert("running".into(), json!(true));
            }
            let encoded = serde_json::to_string(&status_val).map_err(io::Error::other)?;
            crate::finish_stdout(writeln!(
                io::stdout(),
                "{}",
                crate::text::escape_json_controls(&encoded)
            ))?;
        } else {
            let pid = status_val["pid"].as_u64().unwrap_or(0);
            let transport = status_val["transport"].as_str().unwrap_or("unknown");
            let clients = status_val["connectedClients"].as_u64().unwrap_or(0);
            let endpoint = status_val["endpoint"].as_str().unwrap_or("");
            crate::finish_stdout(writeln!(
                io::stdout(),
                "peer core daemon: running (pid {pid}, transport={transport}, clients={clients}, endpoint={endpoint})"
            ))?;
        }
        return Ok(CliExit::Ok);
    }

    if let Some(stale) = descriptor {
        cleanup_stale_descriptor(&data_home, &stale);
    }
    if json_out {
        let payload = json!({
            "running": false,
            "dataHome": data_home.to_string_lossy(),
        });
        let encoded = serde_json::to_string(&payload).map_err(io::Error::other)?;
        crate::finish_stdout(writeln!(
            io::stdout(),
            "{}",
            crate::text::escape_json_controls(&encoded)
        ))?;
    } else {
        crate::finish_stdout(writeln!(io::stdout(), "peer core daemon: stopped"))?;
    }
    Ok(CliExit::Ok)
}

pub fn run_stop() -> io::Result<CliExit> {
    let data_home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let descriptor = read_daemon_descriptor(&data_home).ok().flatten();
    let Some(desc) = descriptor else {
        crate::finish_stdout(writeln!(io::stdout(), "peer core daemon: not running"))?;
        return Ok(CliExit::Ok);
    };

    let stopped = crate::cancellation::run(|_| async {
        tokio::time::timeout(DAEMON_CONTROL_TIMEOUT, async {
            let client =
                DaemonClient::connect_descriptor(&desc, "peer-cli", crate::VERSION.trim(), vec![])
                    .await?;
            let _ = client.shutdown_daemon().await?;
            Ok::<(), io::Error>(())
        })
        .await
        .is_ok_and(|res| res.is_ok())
    })?;

    if !stopped {
        cleanup_stale_descriptor(&data_home, &desc);
        crate::finish_stdout(writeln!(
            io::stdout(),
            "peer core daemon: not running (cleaned stale state)"
        ))?;
        return Ok(CliExit::Ok);
    }

    let desc_path = daemon_descriptor_path(&data_home);
    let wait_start = std::time::Instant::now();
    while desc_path.exists() && wait_start.elapsed() < DAEMON_CONTROL_TIMEOUT {
        std::thread::sleep(Duration::from_millis(25));
    }

    crate::finish_stdout(writeln!(io::stdout(), "peer core daemon: stopped"))?;
    Ok(CliExit::Ok)
}
