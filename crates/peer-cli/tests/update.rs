#![forbid(unsafe_code)]
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tempfile::tempdir;

fn peer_bin() -> &'static str {
    env!("CARGO_BIN_EXE_peer-native")
}

fn spawn_mock_release_server(
    releases_json: String,
    archive_path: String,
    archive_bytes: Vec<u8>,
) -> (String, Arc<AtomicBool>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_bg = stop.clone();
    let handle = thread::spawn(move || {
        while !stop_bg.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]);
                    let first_line = req.lines().next().unwrap_or("");
                    let path = first_line.split_whitespace().nth(1).unwrap_or("/");
                    if path.starts_with("/releases") {
                        let body = releases_json.as_bytes();
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(body);
                    } else if path == archive_path {
                        let header = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            archive_bytes.len()
                        );
                        let _ = stream.write_all(header.as_bytes());
                        let _ = stream.write_all(&archive_bytes);
                    } else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nnot found",
                        );
                    }
                    let _ = stream.flush();
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
            }
        }
    });
    (format!("http://127.0.0.1:{}", addr.port()), stop, handle)
}

fn make_tar_gz(dir: &Path, folder_name: &str, files: &[(&str, &[u8])]) -> Vec<u8> {
    let stage = dir.join("stage");
    let folder = stage.join(folder_name);
    fs::create_dir_all(&folder).unwrap();
    for (name, bytes) in files {
        let p = folder.join(name);
        fs::write(&p, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    let out = dir.join("release.tar.gz");
    let status = Command::new("/usr/bin/tar")
        .args(["-czf"])
        .arg(&out)
        .arg("-C")
        .arg(&stage)
        .arg(folder_name)
        .status()
        .unwrap();
    assert!(status.success(), "tar create failed");
    fs::read(&out).unwrap()
}

#[test]
fn peer_update_help_and_usage_errors_never_touch_network() {
    let help = Command::new(peer_bin())
        .args(["update", "--help"])
        .env("PATH", "/nonexistent")
        .output()
        .unwrap();
    assert_eq!(help.status.code(), Some(0));
    let out = String::from_utf8_lossy(&help.stdout);
    assert!(out.contains("peer update --check"), "stdout: {out}");

    let bad_opt = Command::new(peer_bin())
        .args(["update", "--force"])
        .output()
        .unwrap();
    assert_eq!(bad_opt.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&bad_opt.stderr).contains("peer update: unknown option --force")
    );

    let bad_arg = Command::new(peer_bin())
        .args(["update", "now"])
        .output()
        .unwrap();
    assert_eq!(bad_arg.status.code(), Some(2));
    assert!(
        String::from_utf8_lossy(&bad_arg.stderr).contains("peer update: unexpected argument now")
    );
}

#[test]
fn peer_update_check_matches_channel_and_install_swaps_atomically() {
    let dir = tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();

    let archive_name = peer_cli::update::archive_name();
    let folder = archive_name.trim_end_matches(".tar.gz");
    let valid_tar = make_tar_gz(
        &dir.path().join("valid"),
        folder,
        &[
            ("peer", b"#!/bin/sh\necho peer 0.1.0-rc.99\n"),
            ("peer-credential-helper", b"new-helper-bytes-v99"),
        ],
    );
    let releases = json!([
        {
            "tag_name": "v9.9.9",
            "html_url": "https://example.invalid/releases/v9.9.9",
            "draft": false,
            "prerelease": false
        },
        {
            "tag_name": "v0.1.0-rc.100",
            "html_url": "https://example.invalid/releases/v0.1.0-rc.100",
            "draft": true,
            "prerelease": true
        },
        {
            "tag_name": "v0.1.0-rc.99",
            "html_url": "https://example.invalid/releases/v0.1.0-rc.99",
            "draft": false,
            "prerelease": true
        }
    ])
    .to_string();
    let archive_path = format!("/download/v0.1.0-rc.99/{archive_name}");
    let (base, stop, handle) = spawn_mock_release_server(releases, archive_path, valid_tar);

    // 1. --check when already at latest rc
    let current = Command::new(peer_bin())
        .args(["update", "--check"])
        .env("PEER_AGENT_HOME", &home)
        .env("PEER_CLI_VERSION", "0.1.0-rc.99")
        .env("PEER_AGENT_UPDATE_API_URL", format!("{base}/releases"))
        .env("NO_PROXY", "*")
        .output()
        .unwrap();
    assert_eq!(current.status.code(), Some(0));
    let out = String::from_utf8_lossy(&current.stdout);
    assert!(
        out.contains("peer 0.1.0-rc.99 is already the latest rc release."),
        "stdout: {out}"
    );

    // 2. --check when newer rc exists (ignores v9.9.9 stable and draft v0.1.0-rc.100)
    let avail = Command::new(peer_bin())
        .args(["update", "--check"])
        .env("PEER_AGENT_HOME", &home)
        .env("PEER_CLI_VERSION", "0.1.0-rc.40")
        .env("PEER_AGENT_UPDATE_API_URL", format!("{base}/releases"))
        .env("NO_PROXY", "*")
        .output()
        .unwrap();
    assert_eq!(avail.status.code(), Some(0));
    let out = String::from_utf8_lossy(&avail.stdout);
    assert!(
        out.contains("peer 0.1.0-rc.40 → 0.1.0-rc.99 (rc, release)"),
        "stdout: {out}"
    );
    assert!(out.contains("https://example.invalid/releases/v0.1.0-rc.99"));

    // 3. Refuses to replace non-`peer` binary name (`peer-native`)
    let refused = Command::new(peer_bin())
        .args(["update"])
        .env("PEER_AGENT_HOME", &home)
        .env("PEER_CLI_VERSION", "0.1.0-rc.40")
        .env("PEER_AGENT_UPDATE_API_URL", format!("{base}/releases"))
        .env(
            "PEER_AGENT_UPDATE_DOWNLOAD_BASE",
            format!("{base}/download"),
        )
        .env("NO_PROXY", "*")
        .output()
        .unwrap();
    assert_eq!(refused.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("refusing to replace"),
        "stderr: {}",
        String::from_utf8_lossy(&refused.stderr)
    );

    // 4. Real atomic swap when invoked as `peer` alongside `peer-credential-helper`
    let install_dir = dir.path().join("install");
    fs::create_dir_all(&install_dir).unwrap();
    let installed_peer = install_dir.join("peer");
    let installed_helper = install_dir.join("peer-credential-helper");
    fs::copy(peer_bin(), &installed_peer).unwrap();
    fs::write(&installed_helper, b"old-helper-bytes").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&installed_peer, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&installed_helper, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let swap = Command::new(&installed_peer)
        .args(["update"])
        .env("PATH", "/nonexistent")
        .env("PEER_AGENT_HOME", &home)
        .env("PEER_CLI_VERSION", "0.1.0-rc.40")
        .env("PEER_AGENT_UPDATE_API_URL", format!("{base}/releases"))
        .env(
            "PEER_AGENT_UPDATE_DOWNLOAD_BASE",
            format!("{base}/download"),
        )
        .env("NO_PROXY", "*")
        .output()
        .unwrap();
    assert_eq!(
        swap.status.code(),
        Some(0),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&swap.stdout),
        String::from_utf8_lossy(&swap.stderr)
    );
    assert!(
        String::from_utf8_lossy(&swap.stdout)
            .contains("Updated to 0.1.0-rc.99. Restart peer to use it.")
    );
    assert_eq!(
        fs::read(&installed_peer).unwrap(),
        b"#!/bin/sh\necho peer 0.1.0-rc.99\n"
    );
    assert_eq!(
        fs::read(&installed_helper).unwrap(),
        b"new-helper-bytes-v99"
    );
    assert!(install_dir.join("peer.previous").exists());
    assert_eq!(
        fs::read(install_dir.join("peer-credential-helper.previous")).unwrap(),
        b"old-helper-bytes"
    );
    assert!(!install_dir.join("peer.next").exists());

    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();
}

#[test]
fn peer_update_rejects_incomplete_archive_without_modifying_installed_binaries() {
    let dir = tempdir().unwrap();
    let home = dir.path().join("home");
    fs::create_dir_all(&home).unwrap();

    let archive_name = peer_cli::update::archive_name();
    let folder = archive_name.trim_end_matches(".tar.gz");
    // Missing peer-credential-helper!
    let incomplete_tar = make_tar_gz(
        &dir.path().join("incomplete"),
        folder,
        &[("peer", b"#!/bin/sh\necho broken\n")],
    );
    let releases = json!([
        {
            "tag_name": "v0.1.0-rc.99",
            "html_url": "https://example.invalid/releases/v0.1.0-rc.99",
            "draft": false,
            "prerelease": true
        }
    ])
    .to_string();
    let archive_path = format!("/download/v0.1.0-rc.99/{archive_name}");
    let (base, stop, handle) = spawn_mock_release_server(releases, archive_path, incomplete_tar);

    let install_dir = dir.path().join("install");
    fs::create_dir_all(&install_dir).unwrap();
    let installed_peer = install_dir.join("peer");
    let installed_helper = install_dir.join("peer-credential-helper");
    fs::copy(peer_bin(), &installed_peer).unwrap();
    let orig_peer_len = fs::metadata(&installed_peer).unwrap().len();
    fs::write(&installed_helper, b"keep-helper").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&installed_peer, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let res = Command::new(&installed_peer)
        .args(["update"])
        .env("PATH", "/nonexistent")
        .env("PEER_AGENT_HOME", &home)
        .env("PEER_CLI_VERSION", "0.1.0-rc.40")
        .env("PEER_AGENT_UPDATE_API_URL", format!("{base}/releases"))
        .env(
            "PEER_AGENT_UPDATE_DOWNLOAD_BASE",
            format!("{base}/download"),
        )
        .env("NO_PROXY", "*")
        .output()
        .unwrap();
    assert_eq!(res.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&res.stderr)
            .contains("release archive does not contain peer and peer-credential-helper")
    );
    assert_eq!(fs::metadata(&installed_peer).unwrap().len(), orig_peer_len);
    assert_eq!(fs::read(&installed_helper).unwrap(), b"keep-helper");

    stop.store(true, Ordering::Relaxed);
    let _ = handle.join();
}
