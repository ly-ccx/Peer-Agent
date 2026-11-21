//! ADR-127 bounded, read-only Git status. Fixed argv, clean Git environment,
//! disabled hooks/fsmonitor/filters, scope checks and re-observed identity/status.
use crate::git_read::{AuthorityFuture, GitReadAuthority, command};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
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
// Reconciliation is not a tool authorization source. Its original restrictive
// authorize() below remains authoritative; the common runner owns processes.
struct ProbeAuthority;
impl GitReadAuthority for ProbeAuthority {
    fn check(&self) -> AuthorityFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn authorize<'a>(&'a self, _: &'a Path) -> AuthorityFuture<'a> {
        self.check()
    }
}
impl Query<'_> {
    async fn run(&mut self, args: &[&str], codes: &[i32]) -> Result<Output, GitProbeError> {
        if self.cancel.is_cancelled() {
            return Err(GitProbeError("git_query_cancelled"));
        }
        if self.started.elapsed() >= Duration::from_secs(10) {
            return Err(GitProbeError("git_query_timeout"));
        }
        let raw = command::run(command::Request {
            binary: self.binary,
            cwd: &self.root,
            binding: &self.binding,
            filters: &self.filters,
            common: self.common.as_deref(),
            args,
            budget: &mut self.remaining,
            deadline: command::Deadline::Total(tokio::time::Instant::from_std(
                self.started + Duration::from_secs(10),
            )),
            authority: &ProbeAuthority,
            cancel: self.cancel,
        })
        .await
        .map_err(|e| {
            GitProbeError(match e.code {
                "git_execution_permission_denied" | "git_query_spawn_failed" => "git_unavailable",
                _ => e.code,
            })
        })?;
        if self.cancel.is_cancelled() {
            return Err(GitProbeError("git_query_cancelled"));
        }
        let code = raw.code;
        let out = raw.stdout;
        let err = raw.stderr;
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
