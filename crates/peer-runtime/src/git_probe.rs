//! ADR-127 bounded, read-only Git status. Fixed argv, clean Git environment,
//! disabled hooks/fsmonitor/filters, scope checks and re-observed identity/status.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitProbeError(pub &'static str);
pub struct GitStatusProbe {
    binary: PathBuf,
}
impl Default for GitStatusProbe {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("/usr/bin/git"),
        }
    }
}
struct Query<'a> {
    binary: &'a Path,
    root: PathBuf,
    remaining: usize,
    started: Instant,
    binding: Vec<String>,
    filters: Vec<String>,
    common: Option<PathBuf>,
    cancel: &'a CancellationToken,
}
struct Output {
    code: i32,
    out: String,
}
async fn collect(
    mut stream: impl AsyncRead + Unpin,
    budget: Arc<AtomicUsize>,
) -> Result<Vec<u8>, GitProbeError> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream
            .read(&mut chunk)
            .await
            .map_err(|_| GitProbeError("git_query_failed"))?;
        if n == 0 {
            return Ok(bytes);
        }
        budget
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |r| r.checked_sub(n))
            .map_err(|_| GitProbeError("git_query_output_limit"))?;
        bytes.extend_from_slice(&chunk[..n]);
    }
}
impl Query<'_> {
    async fn run(&mut self, args: &[&str], codes: &[i32]) -> Result<Output, GitProbeError> {
        if self.cancel.is_cancelled() {
            return Err(GitProbeError("git_query_cancelled"));
        }
        let wait = Duration::from_secs(10)
            .checked_sub(self.started.elapsed())
            .ok_or(GitProbeError("git_query_timeout"))?;
        let mut command = Command::new(self.binary);
        command
            .args([
                "--no-pager",
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "gc.auto=0",
                "-c",
                "maintenance.auto=false",
                "-c",
                "core.quotePath=false",
                "-c",
                "log.showSignature=false",
                "-c",
                "status.submoduleSummary=false",
            ])
            .args(&self.binding)
            .args(&self.filters)
            .args(args)
            .current_dir(&self.root)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in std::env::vars_os() {
            let name = key.to_string_lossy().to_ascii_uppercase();
            if !name.starts_with("GIT_") && !["PAGER", "LESS", "LV"].contains(&name.as_str()) {
                command.env(key, value);
            }
        }
        for (key, value) in [
            ("GIT_OPTIONAL_LOCKS", "0"),
            ("GIT_TERMINAL_PROMPT", "0"),
            ("GIT_NO_LAZY_FETCH", "1"),
            ("GIT_ATTR_NOSYSTEM", "1"),
            ("GIT_ALLOW_PROTOCOL", ""),
            ("GIT_NO_REPLACE_OBJECTS", "1"),
            ("LC_ALL", "C"),
            ("LANG", "C"),
        ] {
            command.env(key, value);
        }
        if let Some(common) = &self.common {
            command.env("GIT_COMMON_DIR", common);
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|_| GitProbeError("git_unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(GitProbeError("git_query_failed"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or(GitProbeError("git_query_failed"))?;
        let budget = Arc::new(AtomicUsize::new(self.remaining));
        let work = async {
            let wait = async {
                child
                    .wait()
                    .await
                    .map_err(|_| GitProbeError("git_query_failed"))
            };
            let (out, err, status) = tokio::try_join!(
                collect(stdout, budget.clone()),
                collect(stderr, budget.clone()),
                wait
            )?;
            Ok::<_, GitProbeError>((out, err, status))
        };
        let result = tokio::select! {r=tokio::time::timeout(wait,work)=>r.map_err(|_|GitProbeError("git_query_timeout")).and_then(|r|r), _=self.cancel.cancelled()=>Err(GitProbeError("git_query_cancelled"))};
        self.remaining = budget.load(Ordering::Acquire);
        let (out, err, status) = match result {
            Ok(r) => r,
            Err(e) => {
                #[cfg(unix)]
                if let Some(pid) = child
                    .id()
                    .and_then(|p| rustix::process::Pid::from_raw(p as i32))
                {
                    let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                }
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(e);
            }
        };
        if self.cancel.is_cancelled() {
            return Err(GitProbeError("git_query_cancelled"));
        }
        let code = status.code().ok_or(GitProbeError("git_query_failed"))?;
        if !codes.contains(&code) {
            let err = String::from_utf8_lossy(&err);
            return Err(GitProbeError(if err.contains("not a git repository") {
                "git_not_repository"
            } else if err.contains("dubious ownership") {
                "git_repository_untrusted"
            } else {
                "git_query_failed"
            }));
        }
        Ok(Output {
            code,
            out: String::from_utf8(out)
                .map_err(|_| GitProbeError("git_query_encoding_unsupported"))?,
        })
    }
    fn authorize(&self, path: &Path) -> Result<(), GitProbeError> {
        let config = path
            .file_name()
            .is_some_and(|s| s == ".gitconfig" || s == "gitconfig")
            || path.ends_with("git/config");
        if path == self.root || path.starts_with(&self.root) || config {
            Ok(())
        } else {
            Err(GitProbeError("reconciliation_scope_exceeded"))
        }
    }
    async fn identity(&mut self) -> Result<Value, GitProbeError> {
        let head = self
            .run(&["rev-parse", "--verify", "--quiet", "HEAD"], &[0, 1])
            .await?;
        let branch = self
            .run(&["symbolic-ref", "--quiet", "--short", "HEAD"], &[0, 1])
            .await?;
        Ok(
            json!({"head":(head.code==0).then(||head.out.trim().to_owned()),"branch":(branch.code==0).then(||branch.out.trim_end().to_owned())}),
        )
    }
}
impl GitStatusProbe {
    pub async fn observe(
        &self,
        directory: &Path,
        cancel: &CancellationToken,
    ) -> Result<Value, GitProbeError> {
        let root =
            std::fs::canonicalize(directory).map_err(|_| GitProbeError("git_unavailable"))?;
        let mut query = Query {
            binary: &self.binary,
            root,
            remaining: 256 * 1024,
            started: Instant::now(),
            binding: Vec::new(),
            filters: Vec::new(),
            common: None,
            cancel,
        };
        let top = query
            .run(&["rev-parse", "--show-toplevel"], &[0])
            .await?
            .out;
        let top = std::fs::canonicalize(top.trim_end_matches(['\r', '\n']))
            .map_err(|_| GitProbeError("git_query_failed"))?;
        query.authorize(&top)?;
        let git = query
            .run(&["rev-parse", "--absolute-git-dir"], &[0])
            .await?
            .out;
        let git = std::fs::canonicalize(git.trim_end_matches(['\r', '\n']))
            .map_err(|_| GitProbeError("git_query_failed"))?;
        query.authorize(&git)?;
        let common = query
            .run(&["rev-parse", "--git-common-dir"], &[0])
            .await?
            .out;
        let common = std::fs::canonicalize(query.root.join(common.trim_end_matches(['\r', '\n'])))
            .map_err(|_| GitProbeError("git_query_failed"))?;
        query.authorize(&common)?;
        query.common = Some(common);
        query.binding = vec![
            format!(
                "--git-dir={}",
                git.to_str()
                    .ok_or(GitProbeError("git_query_encoding_unsupported"))?
            ),
            format!(
                "--work-tree={}",
                top.to_str()
                    .ok_or(GitProbeError("git_query_encoding_unsupported"))?
            ),
        ];
        let config = query
            .run(
                &[
                    "config",
                    "--includes",
                    "--show-origin",
                    "--name-only",
                    "--null",
                    "--list",
                ],
                &[0],
            )
            .await?
            .out;
        let fields: Vec<_> = config.split('\0').collect();
        for pair in fields.as_chunks::<2>().0 {
            if let Some(source) = pair[0].strip_prefix("file:") {
                let source = std::fs::canonicalize(query.root.join(source))
                    .map_err(|_| GitProbeError("git_query_failed"))?;
                query.authorize(&source)?;
            }
        }
        let filters = query
            .run(
                &[
                    "config",
                    "--includes",
                    "--null",
                    "--name-only",
                    "--get-regexp",
                    "^filter\\..*\\.(clean|smudge|process|required)$",
                ],
                &[0, 1],
            )
            .await?
            .out;
        let mut keys = Vec::new();
        for key in filters.split('\0').filter(|s| !s.is_empty()) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        if keys.len() > 128 || keys.iter().any(|s| s.len() > 512) {
            return Err(GitProbeError("git_query_filter_limit"));
        }
        for key in &keys {
            query.filters.push("-c".into());
            query.filters.push(format!(
                "{key}={}",
                if key.ends_with(".required") {
                    "false"
                } else {
                    ""
                }
            ));
        }
        let before = query.identity().await?;
        let args = [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ];
        let raw = query.run(&args, &[0]).await?.out;
        let index = query.run(&["ls-files", "--stage", "-z"], &[0]).await?.out;
        let submodules = index
            .split('\0')
            .filter(|s| s.starts_with("160000 "))
            .count();
        let after = query.identity().await?;
        let consistent = before == after && raw == query.run(&args, &[0]).await?.out;
        let mut changed = 0;
        let mut untracked = 0;
        let mut paths = Vec::new();
        let mut fields = raw.split('\0').filter(|s| !s.is_empty());
        while let Some(row) = fields.next() {
            let bytes = row.as_bytes();
            if bytes.len() < 3 || bytes[2] != b' ' || !bytes[0].is_ascii() || !bytes[1].is_ascii() {
                return Err(GitProbeError("git_query_failed"));
            }
            if bytes[0] == b'?' {
                untracked += 1;
            } else {
                changed += 1;
            }
            if paths.len() < 32 {
                paths.push(row[3..].to_owned());
            }
            if bytes[..2].iter().any(|b| b"RC".contains(b)) {
                fields.next().ok_or(GitProbeError("git_query_failed"))?;
            }
        }
        let clean = if !consistent || !keys.is_empty() {
            None
        } else if changed + untracked > 0 {
            Some(false)
        } else if submodules > 0 {
            None
        } else {
            Some(true)
        };
        Ok(
            json!({"clean":clean,"changed":changed,"untracked":untracked,"consistent":consistent,"paths":paths}),
        )
    }
}
