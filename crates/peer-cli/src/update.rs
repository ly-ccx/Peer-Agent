//! Native `peer update [--check]` implementation matching ADR 48 and ADR 108.
//! Checks GitHub Releases on the matching channel (`stable`, `beta`, `rc`) and
//! atomically swaps `peer` + `peer-credential-helper` with full rollback on error.
use peer_protocol::CliExit;
use serde_json::Value;
use std::{
    cmp::Ordering,
    env, fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_REPOSITORY: &str = "ly-ccx/Peer-Agent";
const UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RELEASE_LIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateChannel {
    Stable,
    Beta,
    Rc,
}

impl UpdateChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Beta => "beta",
            Self::Rc => "rc",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallSource {
    Release,
    Npm,
    Pnpm,
}

impl InstallSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Release => "release",
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Release => "the release archive",
            Self::Npm => "npm",
            Self::Pnpm => "pnpm",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub source: InstallSource,
    pub release_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateLookup {
    Available(UpdateInfo),
    Current {
        current_version: String,
        channel: UpdateChannel,
    },
    UnrecognizedVersion(String),
    Failed(String),
}

/// Parses `X.Y.Z`, `X.Y.Z-beta.N`, or `X.Y.Z-rc.N` (with optional leading `v`).
/// Returns `[major, minor, patch, channel_rank, prerelease]` where `beta=0`, `rc=1`, `stable=2`.
pub fn parse_version(raw: &str) -> Option<[u64; 5]> {
    let trimmed = raw.trim();
    let body = trimmed.strip_prefix('v').unwrap_or(trimmed);
    let (core, pre) = match body.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (body, None),
    };
    let mut parts = core.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next()?.parse().ok()?;
    let patch: u64 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let (rank, num) = match pre {
        None => (2u64, 0u64),
        Some(tag) => {
            let (kind, n) = tag.split_once('.')?;
            let rank = match kind {
                "beta" => 0,
                "rc" => 1,
                _ => return None,
            };
            let num: u64 = n.parse().ok()?;
            (rank, num)
        }
    };
    Some([major, minor, patch, rank, num])
}

pub fn compare_versions(left: &str, right: &str) -> Ordering {
    match (parse_version(left), parse_version(right)) {
        (Some(a), Some(b)) => a.cmp(&b),
        _ => Ordering::Equal,
    }
}

pub fn update_channel(version: &str) -> UpdateChannel {
    if version.contains("-beta.") {
        UpdateChannel::Beta
    } else if version.contains("-rc.") {
        UpdateChannel::Rc
    } else {
        UpdateChannel::Stable
    }
}

pub fn resolve_install_source() -> InstallSource {
    match env::var("PEER_AGENT_INSTALL_SOURCE").as_deref() {
        Ok("pnpm") => InstallSource::Pnpm,
        Ok("npm") => InstallSource::Npm,
        _ => InstallSource::Release,
    }
}

/// Release installs replace the running binary. Never treat another executable as `peer`.
pub fn resolve_release_install_target(exec_path: &Path) -> Result<PathBuf, String> {
    let name = exec_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if name != "peer" && name != "peer.exe" {
        return Err(format!(
            "peer update: refusing to replace {}",
            exec_path.display()
        ));
    }
    Ok(exec_path.to_path_buf())
}

pub fn archive_name() -> String {
    let os = match env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    };
    let arch = match env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    format!("peer-{os}-{arch}.tar.gz")
}

pub fn help_text() -> String {
    let ver = current_version();
    [
        format!("peer {ver}"),
        String::new(),
        "peer update — install the newest release on this channel".into(),
        String::new(),
        "Usage:".into(),
        "  peer update".into(),
        "  peer update --check".into(),
        String::new(),
        "Channels stay separate: stable, beta (-beta.N), and rc (-rc.N).".into(),
        "npm and pnpm installs upgrade that global package.".into(),
        "A release-archive install replaces peer and peer-credential-helper.".into(),
        "Restart peer after a successful update.".into(),
        "This command always checks. PEER_AGENT_NO_UPDATE_CHECK=1 only disables the background prompt.".into(),
    ]
    .join("\n")
}

pub fn parse(argv: &[String]) -> crate::Command {
    let mut check_only = false;
    for arg in argv {
        if matches!(arg.as_str(), "--help" | "-h") {
            return crate::Command::UpdateHelp;
        }
        if arg == "--check" {
            check_only = true;
            continue;
        }
        let message = if arg.starts_with('-') {
            format!(
                "peer update: unknown option {}",
                crate::text::diagnostic(arg)
            )
        } else {
            format!(
                "peer update: unexpected argument {}",
                crate::text::diagnostic(arg)
            )
        };
        return crate::Command::Usage(message);
    }
    crate::Command::Update { check_only }
}

fn current_version() -> String {
    env::var("PEER_CLI_VERSION")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::VERSION.trim().to_owned())
}

fn repository() -> String {
    env::var("PEER_AGENT_GITHUB_REPOSITORY")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_REPOSITORY.to_owned())
}

fn record_check_timestamp() {
    let Some(home) = peer_protocol::data_home() else {
        return;
    };
    let state_path = home.join("cli-update.json");
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Some(parent) = state_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&state_path, format!("{{\"checkedAt\":{now_ms}}}\n"));
}

fn release_matches_channel(release: &Value, channel: UpdateChannel) -> Option<&str> {
    if release.get("draft").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let tag = release.get("tag_name").and_then(Value::as_str)?;
    parse_version(tag)?;
    if update_channel(tag) != channel {
        return None;
    }
    let is_pre = release
        .get("prerelease")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let matches_pre = match channel {
        UpdateChannel::Stable => !is_pre,
        UpdateChannel::Beta | UpdateChannel::Rc => is_pre,
    };
    matches_pre.then_some(tag)
}

async fn lookup_update(current: &str) -> UpdateLookup {
    if parse_version(current).is_none() {
        return UpdateLookup::UnrecognizedVersion(current.to_owned());
    }
    record_check_timestamp();

    let repo = repository();
    let api_url = env::var("PEER_AGENT_UPDATE_API_URL")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("https://api.github.com/repos/{repo}/releases?per_page=20"));
    let user_agent = format!("peer-cli/{current}");

    let bytes = match peer_runtime::http_fetch::get_bytes(
        &api_url,
        Some("application/vnd.github+json"),
        &user_agent,
        UPDATE_CHECK_TIMEOUT,
        MAX_RELEASE_LIST_BYTES,
    )
    .await
    {
        Ok(b) => b,
        Err(e) => return UpdateLookup::Failed(e),
    };

    let parsed: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return UpdateLookup::Failed(format!("invalid release JSON: {e}")),
    };
    let Some(releases) = parsed.as_array() else {
        return UpdateLookup::Failed("response was not a list".into());
    };

    let channel = update_channel(current);
    let mut candidates: Vec<(&str, &Value)> = releases
        .iter()
        .filter_map(|rel| release_matches_channel(rel, channel).map(|tag| (tag, rel)))
        .collect();
    candidates.sort_by(|(a, _), (b, _)| compare_versions(b, a));

    let Some((latest_tag, latest_rel)) = candidates.first().copied() else {
        return UpdateLookup::Current {
            current_version: current.to_owned(),
            channel,
        };
    };
    if compare_versions(current, latest_tag) != Ordering::Less {
        return UpdateLookup::Current {
            current_version: current.to_owned(),
            channel,
        };
    }

    let latest_version = latest_tag
        .strip_prefix('v')
        .unwrap_or(latest_tag)
        .to_owned();
    let release_url = latest_rel
        .get("html_url")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("https://github.com/{repo}/releases/tag/{latest_tag}"));

    UpdateLookup::Available(UpdateInfo {
        current_version: current.to_owned(),
        latest_version,
        source: resolve_install_source(),
        release_url,
    })
}

fn find_tar_executable() -> &'static str {
    for candidate in ["/usr/bin/tar", "/bin/tar"] {
        if Path::new(candidate).is_file() {
            return candidate;
        }
    }
    "tar"
}

fn find_release_binaries(root: &Path) -> io::Result<Option<(PathBuf, PathBuf)>> {
    let peer_name = if cfg!(windows) { "peer.exe" } else { "peer" };
    let helper_name = if cfg!(windows) {
        "peer-credential-helper.exe"
    } else {
        "peer-credential-helper"
    };
    let mut peer = None;
    let mut helper = None;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let ftype = entry.file_type()?;
            if ftype.is_dir() {
                stack.push(path);
            } else if ftype.is_file() {
                let fname = entry.file_name();
                if fname == peer_name {
                    peer = Some(path);
                } else if fname == helper_name {
                    helper = Some(path);
                }
            }
        }
    }
    Ok(match (peer, helper) {
        (Some(p), Some(h)) => Some((p, h)),
        _ => None,
    })
}

#[cfg(unix)]
fn set_executable(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn atomic_swap_pair(
    executable: &Path,
    helper: &Path,
    new_peer: &Path,
    new_helper: &Path,
) -> Result<(), String> {
    let staged_peer = PathBuf::from(format!("{}.next", executable.display()));
    let staged_helper = PathBuf::from(format!("{}.next", helper.display()));
    let backup_peer = PathBuf::from(format!("{}.previous", executable.display()));
    let backup_helper = PathBuf::from(format!("{}.previous", helper.display()));

    let _ = fs::remove_file(&staged_peer);
    let _ = fs::remove_file(&staged_helper);

    let stage_result = (|| -> io::Result<()> {
        fs::copy(new_peer, &staged_peer)?;
        fs::copy(new_helper, &staged_helper)?;
        set_executable(&staged_peer)?;
        set_executable(&staged_helper)?;
        Ok(())
    })();
    if let Err(e) = stage_result {
        let _ = fs::remove_file(&staged_peer);
        let _ = fs::remove_file(&staged_helper);
        return Err(format!("failed to stage replacement binaries: {e}"));
    }

    let _ = fs::remove_file(&backup_peer);
    let _ = fs::remove_file(&backup_helper);

    let had_helper = helper.exists();
    if let Err(e) = fs::rename(executable, &backup_peer) {
        let _ = fs::remove_file(&staged_peer);
        let _ = fs::remove_file(&staged_helper);
        return Err(format!("failed to back up peer binary: {e}"));
    }

    let swap_result = (|| -> io::Result<()> {
        if had_helper {
            fs::rename(helper, &backup_helper)?;
        }
        fs::rename(&staged_peer, executable)?;
        fs::rename(&staged_helper, helper)?;
        Ok(())
    })();

    if let Err(e) = swap_result {
        let _ = fs::remove_file(executable);
        let _ = fs::remove_file(helper);
        let _ = fs::rename(&backup_peer, executable);
        if had_helper {
            let _ = fs::rename(&backup_helper, helper);
        }
        let _ = fs::remove_file(&staged_peer);
        let _ = fs::remove_file(&staged_helper);
        return Err(format!("failed to swap binaries: {e}"));
    }

    let _ = fs::remove_file(&staged_peer);
    let _ = fs::remove_file(&staged_helper);
    Ok(())
}

async fn install_release_update(update: &UpdateInfo) -> Result<(), String> {
    let current_exe =
        env::current_exe().map_err(|e| format!("cannot locate current binary: {e}"))?;
    let executable = resolve_release_install_target(&current_exe)?;
    let helper_name = if cfg!(windows) {
        "peer-credential-helper.exe"
    } else {
        "peer-credential-helper"
    };
    let helper = executable
        .parent()
        .ok_or_else(|| "cannot resolve install directory".to_owned())?
        .join(helper_name);

    let repo = repository();
    let archive = archive_name();
    let download_base = env::var("PEER_AGENT_UPDATE_DOWNLOAD_BASE")
        .ok()
        .map(|s| s.trim_end_matches('/').to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("https://github.com/{repo}/releases/download"));
    let url = format!("{download_base}/v{}/{archive}", update.latest_version);
    let user_agent = format!("peer-cli/{}", update.current_version);

    let archive_bytes = peer_runtime::http_fetch::get_bytes(
        &url,
        None,
        &user_agent,
        UPDATE_DOWNLOAD_TIMEOUT,
        MAX_ARCHIVE_BYTES,
    )
    .await
    .map_err(|e| format!("download failed: {e}"))?;

    let temp = tempfile::Builder::new()
        .prefix("peer-update-")
        .tempdir()
        .map_err(|e| format!("tempdir failed: {e}"))?;
    let archive_path = temp.path().join(&archive);
    let extracted = temp.path().join("extracted");
    fs::write(&archive_path, &archive_bytes).map_err(|e| format!("write archive failed: {e}"))?;
    fs::create_dir_all(&extracted).map_err(|e| format!("create extract dir failed: {e}"))?;

    let tar = find_tar_executable();
    let mut extract = Command::new(tar);
    // GNU tar launches gzip through PATH even when tar itself has an absolute path.
    #[cfg(target_os = "linux")]
    if Path::new(tar).is_absolute() {
        extract.env("PATH", "/usr/bin:/bin");
    }
    let status = extract
        .args(["-xzf"])
        .arg(&archive_path)
        .arg("-C")
        .arg(&extracted)
        .status()
        .map_err(|e| format!("tar failed to start: {e}"))?;
    if !status.success() {
        return Err(format!(
            "tar exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }

    let Some((new_peer, new_helper)) = find_release_binaries(&extracted)
        .map_err(|e| format!("inspect extracted archive failed: {e}"))?
    else {
        return Err("release archive does not contain peer and peer-credential-helper".into());
    };

    atomic_swap_pair(&executable, &helper, &new_peer, &new_helper)
}

async fn install_update(update: &UpdateInfo) -> Result<(), String> {
    match update.source {
        InstallSource::Pnpm => {
            let pkg = format!("@peer-agent/cli@{}", update.latest_version);
            let status = Command::new("pnpm")
                .args(["add", "--global", &pkg])
                .status()
                .map_err(|e| format!("pnpm failed to start: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "pnpm exited with status {}",
                    status.code().unwrap_or(-1)
                ))
            }
        }
        InstallSource::Npm => {
            let pkg = format!("@peer-agent/cli@{}", update.latest_version);
            let status = Command::new("npm")
                .args(["install", "--global", &pkg])
                .status()
                .map_err(|e| format!("npm failed to start: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!(
                    "npm exited with status {}",
                    status.code().unwrap_or(-1)
                ))
            }
        }
        InstallSource::Release => install_release_update(update).await,
    }
}

pub fn run(check_only: bool) -> io::Result<CliExit> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let current = current_version();
    let result = rt.block_on(lookup_update(&current));

    let mut out = io::stdout().lock();
    let mut err = io::stderr().lock();

    match result {
        UpdateLookup::UnrecognizedVersion(v) => {
            writeln!(err, "peer update: cannot compare version {v}.")?;
            Ok(CliExit::Runtime)
        }
        UpdateLookup::Failed(msg) => {
            writeln!(err, "peer update: could not check GitHub Releases ({msg}).")?;
            Ok(CliExit::Runtime)
        }
        UpdateLookup::Current {
            current_version,
            channel,
        } => {
            crate::finish_stdout(writeln!(
                out,
                "peer {current_version} is already the latest {} release.",
                channel.as_str()
            ))?;
            Ok(CliExit::Ok)
        }
        UpdateLookup::Available(update) => {
            let channel = update_channel(&update.current_version);
            if check_only {
                crate::finish_stdout(writeln!(
                    out,
                    "peer {} → {} ({}, {})",
                    update.current_version,
                    update.latest_version,
                    channel.as_str(),
                    update.source.as_str()
                ))?;
                crate::finish_stdout(writeln!(out, "{}", update.release_url))?;
                return Ok(CliExit::Ok);
            }

            crate::finish_stdout(writeln!(
                out,
                "Updating peer {} → {} with {}.",
                update.current_version,
                update.latest_version,
                update.source.label()
            ))?;
            drop(out);
            match rt.block_on(install_update(&update)) {
                Ok(()) => {
                    let mut out = io::stdout().lock();
                    crate::finish_stdout(writeln!(
                        out,
                        "Updated to {}. Restart peer to use it.",
                        update.latest_version
                    ))?;
                    Ok(CliExit::Ok)
                }
                Err(msg) => {
                    writeln!(
                        err,
                        "Update failed; the current version is unchanged: {msg}"
                    )?;
                    Ok(CliExit::Runtime)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_channel_ordering_matches_ts_contract() {
        assert_eq!(parse_version("0.1.0-rc.40"), Some([0, 1, 0, 1, 40]));
        assert_eq!(parse_version("v0.1.0-beta.2"), Some([0, 1, 0, 0, 2]));
        assert_eq!(parse_version("0.1.0"), Some([0, 1, 0, 2, 0]));
        assert_eq!(parse_version("dev-snapshot"), None);

        assert_eq!(
            compare_versions("0.1.0-beta.9", "0.1.0-rc.1"),
            Ordering::Less
        );
        assert_eq!(compare_versions("0.1.0-rc.40", "0.1.0"), Ordering::Less);
        assert_eq!(
            compare_versions("0.1.0-rc.40", "0.1.0-rc.41"),
            Ordering::Less
        );
        assert_eq!(
            compare_versions("0.1.0-rc.40", "v0.1.0-rc.40"),
            Ordering::Equal
        );
        assert_eq!(update_channel("0.1.0-rc.40"), UpdateChannel::Rc);
        assert_eq!(update_channel("0.1.0-beta.5"), UpdateChannel::Beta);
        assert_eq!(update_channel("0.1.0"), UpdateChannel::Stable);
    }

    #[test]
    fn install_target_guard_refuses_non_peer_executables() {
        assert!(resolve_release_install_target(Path::new("/usr/local/bin/peer")).is_ok());
        assert!(resolve_release_install_target(Path::new("/opt/bin/peer.exe")).is_ok());
        assert!(resolve_release_install_target(Path::new("/usr/bin/bun")).is_err());
        assert!(resolve_release_install_target(Path::new("/tmp/peer-native")).is_err());
    }

    #[test]
    fn atomic_swap_replaces_both_and_rolls_back_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let peer = dir.path().join("peer");
        let helper = dir.path().join("peer-credential-helper");
        let new_peer = dir.path().join("new-peer");
        let new_helper = dir.path().join("new-helper");
        fs::write(&peer, b"old-peer").unwrap();
        fs::write(&helper, b"old-helper").unwrap();
        fs::write(&new_peer, b"new-peer").unwrap();
        fs::write(&new_helper, b"new-helper").unwrap();

        atomic_swap_pair(&peer, &helper, &new_peer, &new_helper).unwrap();
        assert_eq!(fs::read(&peer).unwrap(), b"new-peer");
        assert_eq!(fs::read(&helper).unwrap(), b"new-helper");
        assert_eq!(
            fs::read(dir.path().join("peer.previous")).unwrap(),
            b"old-peer"
        );
        assert!(!dir.path().join("peer.next").exists());

        // Rollback when helper path is a non-empty directory (rename fails on second step).
        let bad_dir = tempfile::tempdir().unwrap();
        let p2 = bad_dir.path().join("peer");
        let h2 = bad_dir.path().join("peer-credential-helper");
        fs::write(&p2, b"keep-peer").unwrap();
        fs::create_dir(&h2).unwrap();
        fs::write(h2.join("sentinel"), b"keep").unwrap();
        // Also create a conflicting file at backup_helper as a directory so rename(helper, backup_helper) fails!
        fs::create_dir(bad_dir.path().join("peer-credential-helper.previous")).unwrap();
        fs::write(
            bad_dir
                .path()
                .join("peer-credential-helper.previous")
                .join("block"),
            b"x",
        )
        .unwrap();
        let err = atomic_swap_pair(&p2, &h2, &new_peer, &new_helper);
        assert!(err.is_err());
        assert_eq!(fs::read(&p2).unwrap(), b"keep-peer");
        assert_eq!(fs::read(h2.join("sentinel")).unwrap(), b"keep");
    }
}
