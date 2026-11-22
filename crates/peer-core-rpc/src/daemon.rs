//! Cross-platform local shared Peer Core daemon (`peer core --daemon`).
//!
//! Binds an owner-only local IPC endpoint (`0600` Unix Domain Socket on macOS/Linux;
//! owner-restricted Named Pipe on Windows) and writes `<data_home>/core-daemon.json`
//! (`0600` on Unix) containing a per-instance random `authToken` so Desktop and CLI
//! share one live `CoreEngine` and `ProjectHostRuntime` without lease contention.

use crate::{
    client::DaemonClient,
    server::{CoreEngine, CoreServerConfig, DaemonRuntimeMeta, serve_connection},
};
use peer_project_agent::{now_iso, sha256_json};
use peer_runtime::CancellationToken;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::task::JoinSet;

const DESCRIPTOR_VERSION: u32 = 1;
const DESCRIPTOR_FILENAME: &str = "core-daemon.json";
const MAX_UNIX_SOCKET_BYTES: usize = 96;
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonDescriptor {
    pub version: u32,
    pub pid: u32,
    pub server_version: String,
    pub transport: String,
    pub endpoint: String,
    pub auth_token: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct DaemonOptions {
    pub socket_override: Option<PathBuf>,
}

pub type DaemonReadyCallback = Box<dyn FnOnce(&DaemonDescriptor) + Send>;

pub fn daemon_descriptor_path(data_home: &Path) -> PathBuf {
    data_home.join(DESCRIPTOR_FILENAME)
}

pub fn read_daemon_descriptor(data_home: &Path) -> io::Result<Option<DaemonDescriptor>> {
    let path = daemon_descriptor_path(data_home);
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let parsed: DaemonDescriptor = serde_json::from_str(&raw).map_err(|err| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("invalid daemon descriptor {}: {err}", path.display()),
                )
            })?;
            if parsed.version != DESCRIPTOR_VERSION
                || parsed.endpoint.trim().is_empty()
                || parsed.auth_token.trim().is_empty()
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("incomplete daemon descriptor {}", path.display()),
                ));
            }
            Ok(Some(parsed))
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn resolve_daemon_endpoint(
    data_home: &Path,
    socket_override: Option<&Path>,
) -> io::Result<(String, String)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let path = if let Some(override_path) = socket_override {
            if let Some(parent) = override_path.parent()
                && !parent.as_os_str().is_empty()
            {
                fs::create_dir_all(parent)?;
            }
            override_path.to_path_buf()
        } else {
            let run_dir = data_home.join("run");
            let candidate = run_dir.join("core.sock");
            let bytes = candidate.as_os_str().as_encoded_bytes();
            if bytes.len() <= MAX_UNIX_SOCKET_BYTES {
                fs::create_dir_all(&run_dir)?;
                fs::set_permissions(&run_dir, fs::Permissions::from_mode(0o700))?;
                candidate
            } else {
                let canonical =
                    fs::canonicalize(data_home).unwrap_or_else(|_| data_home.to_path_buf());
                let digest = sha256_json(&json!(canonical.to_string_lossy().as_ref()));
                PathBuf::from(format!("/tmp/peer-core-{}.sock", &digest[..16]))
            }
        };
        Ok(("unix".to_owned(), path.to_string_lossy().into_owned()))
    }

    #[cfg(windows)]
    {
        let pipe_name = if let Some(override_path) = socket_override {
            override_path.to_string_lossy().into_owned()
        } else {
            let canonical = fs::canonicalize(data_home).unwrap_or_else(|_| data_home.to_path_buf());
            let digest = sha256_json(&json!(canonical.to_string_lossy().as_ref()));
            format!(r"\\.\pipe\peer-core-{}", &digest[..16])
        };
        Ok(("named_pipe".to_owned(), pipe_name))
    }
}

fn write_daemon_descriptor_atomic(
    data_home: &Path,
    descriptor: &DaemonDescriptor,
) -> io::Result<PathBuf> {
    fs::create_dir_all(data_home)?;
    let target = daemon_descriptor_path(data_home);
    let tmp = data_home.join(format!(
        "core-daemon.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let payload = serde_json::to_vec_pretty(descriptor)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let f = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        f
    };

    #[cfg(not(unix))]
    let mut file = OpenOptions::new().create_new(true).write(true).open(&tmp)?;

    let write_res = (|| -> io::Result<()> {
        file.write_all(&payload)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        Ok(())
    })();
    drop(file);
    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(err) = fs::rename(&tmp, &target) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(target)
}

pub fn cleanup_stale_descriptor(data_home: &Path, existing: &DaemonDescriptor) {
    if read_daemon_descriptor(data_home)
        .ok()
        .flatten()
        .is_some_and(|cur| cur.auth_token == existing.auth_token && cur.pid == existing.pid)
    {
        let _ = fs::remove_file(daemon_descriptor_path(data_home));
    }
    #[cfg(unix)]
    if existing.transport == "unix" {
        let sock = Path::new(&existing.endpoint);
        if sock.exists() && std::os::unix::net::UnixStream::connect(sock).is_err() {
            let _ = fs::remove_file(sock);
        }
    }
}

struct DaemonArtifactsGuard {
    data_home: PathBuf,
    #[cfg_attr(not(unix), allow(dead_code))]
    transport: String,
    #[cfg_attr(not(unix), allow(dead_code))]
    endpoint: String,
    auth_token: String,
    pid: u32,
}

impl Drop for DaemonArtifactsGuard {
    fn drop(&mut self) {
        let matches_ours = match read_daemon_descriptor(&self.data_home) {
            Ok(Some(cur)) => cur.auth_token == self.auth_token && cur.pid == self.pid,
            Ok(None) => false,
            Err(_) => false,
        };
        if matches_ours {
            let _ = fs::remove_file(daemon_descriptor_path(&self.data_home));
        }
        #[cfg(unix)]
        if self.transport == "unix" {
            let sock = Path::new(&self.endpoint);
            if sock.exists()
                && (matches_ours || std::os::unix::net::UnixStream::connect(sock).is_err())
            {
                let _ = fs::remove_file(sock);
            }
        }
    }
}

pub async fn serve_daemon(
    config: CoreServerConfig,
    options: DaemonOptions,
    shutdown: CancellationToken,
    on_ready: Option<DaemonReadyCallback>,
) -> io::Result<()> {
    fs::create_dir_all(&config.data_home)?;

    if let Ok(Some(existing)) = read_daemon_descriptor(&config.data_home) {
        if DaemonClient::probe_descriptor(&existing).await {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                format!(
                    "peer core daemon is already running (pid {}, endpoint {})",
                    existing.pid, existing.endpoint
                ),
            ));
        }
        cleanup_stale_descriptor(&config.data_home, &existing);
    } else if fs::metadata(daemon_descriptor_path(&config.data_home)).is_ok() {
        let _ = fs::remove_file(daemon_descriptor_path(&config.data_home));
    }

    let (transport, endpoint) =
        resolve_daemon_endpoint(&config.data_home, options.socket_override.as_deref())?;
    let auth_token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    #[cfg(unix)]
    let listener = {
        use std::os::unix::fs::PermissionsExt;
        let sock_path = Path::new(&endpoint);
        if sock_path.exists() {
            if std::os::unix::net::UnixStream::connect(sock_path).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    format!("peer core socket already active at {}", sock_path.display()),
                ));
            }
            let _ = fs::remove_file(sock_path);
        }
        let listener = tokio::net::UnixListener::bind(sock_path)?;
        fs::set_permissions(sock_path, fs::Permissions::from_mode(0o600))?;
        listener
    };

    #[cfg(windows)]
    let mut next_server = {
        use tokio::net::windows::named_pipe::ServerOptions;
        ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .create(&endpoint)?
    };

    let descriptor = DaemonDescriptor {
        version: DESCRIPTOR_VERSION,
        pid: std::process::id(),
        server_version: config.version.clone(),
        transport: transport.clone(),
        endpoint: endpoint.clone(),
        auth_token: auth_token.clone(),
        started_at: now_iso(),
    };
    write_daemon_descriptor_atomic(&config.data_home, &descriptor)?;

    let _artifacts_guard = DaemonArtifactsGuard {
        data_home: config.data_home.clone(),
        transport: transport.clone(),
        endpoint: endpoint.clone(),
        auth_token: auth_token.clone(),
        pid: descriptor.pid,
    };

    let engine = CoreEngine::new(
        config,
        shutdown.clone(),
        Some(DaemonRuntimeMeta {
            transport,
            endpoint: endpoint.clone(),
            auth_token,
        }),
    )?;

    if let Some(callback) = on_ready {
        callback(&descriptor);
    }

    let mut connections = JoinSet::new();

    #[cfg(unix)]
    let accept_result: io::Result<()> = loop {
        while connections.try_join_next().is_some() {}
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Ok(()),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let (read_half, write_half) = tokio::io::split(stream);
                    let eng = Arc::clone(&engine);
                    connections.spawn(async move {
                        let _ = serve_connection(eng, read_half, write_half).await;
                    });
                }
                Err(err) => break Err(err),
            }
        }
    };

    #[cfg(unix)]
    drop(listener);

    #[cfg(windows)]
    let accept_result: io::Result<()> = loop {
        while connections.try_join_next().is_some() {}
        tokio::select! {
            biased;
            _ = shutdown.cancelled() => break Ok(()),
            connected = next_server.connect() => match connected {
                Ok(()) => {
                    let connected_pipe = next_server;
                    match tokio::net::windows::named_pipe::ServerOptions::new()
                        .first_pipe_instance(false)
                        .reject_remote_clients(true)
                        .create(&endpoint)
                    {
                        Ok(new_instance) => next_server = new_instance,
                        Err(err) => break Err(err),
                    }
                    let (read_half, write_half) = tokio::io::split(connected_pipe);
                    let eng = Arc::clone(&engine);
                    connections.spawn(async move {
                        let _ = serve_connection(eng, read_half, write_half).await;
                    });
                }
                Err(err) => break Err(err),
            }
        }
    };

    engine.shutdown_and_drain().await;
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }

    accept_result
}
