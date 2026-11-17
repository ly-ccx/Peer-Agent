//! ADR106 read-only Git observations. The caller supplies live Host authority;
//! no model-selected executable, arguments, environment or shell reaches Git.
use crate::CancellationToken;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::OnceLock,
    time::{Duration, Instant},
};
pub(crate) mod command;
#[cfg(test)]
mod tests;
fn contract() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/git-query.json"
        ))
        .expect("compiled Git contract")
    })
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    execution_ms: u64,
    raw_bytes: usize,
    path_bytes: usize,
    status_entries: usize,
    status_path_bytes: usize,
    config_sources: usize,
    origin_entries: usize,
    filter_keys: usize,
    filter_key_bytes: usize,
    observation_json_bytes: usize,
    preview_units: usize,
}
fn limits() -> &'static Limits {
    static DATA: OnceLock<Limits> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_value(contract()["limits"].clone()).expect("compiled Git limits")
    })
}
mod text;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitReadError {
    pub code: &'static str,
    /// False means the real owned process group could not be proved stopped.
    pub ended: bool,
}
impl GitReadError {
    fn new(code: &'static str) -> Self {
        Self { code, ended: true }
    }
}
pub type AuthorityFuture<'a> = Pin<Box<dyn Future<Output = Result<(), GitReadError>> + Send + 'a>>;
pub trait GitReadAuthority: Sync {
    fn check(&self) -> AuthorityFuture<'_>;
    fn authorize<'a>(&'a self, path: &'a Path) -> AuthorityFuture<'a>;
    /// The public capability Adapter journals every real command through its
    /// Host port. Private recovery probes retain their existing narrower owner.
    fn starting(&self) -> AuthorityFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn spawned(&self, _pid: u32) -> AuthorityFuture<'_> {
        Box::pin(async { Ok(()) })
    }
}
pub struct GitRead {
    binary: PathBuf,
}
impl Default for GitRead {
    fn default() -> Self {
        Self {
            binary: "/usr/bin/git".into(),
        }
    }
}
pub(crate) struct Input {
    pub path: PathBuf,
    pub operation: String,
    pub limit: u64,
}
struct Output {
    code: i32,
    stdout: String,
    stderr: String,
}
pub(crate) fn input(value: &Value) -> Result<Input, GitReadError> {
    let invalid = || GitReadError::new("git_query_invalid_input");
    let map = value.as_object().ok_or_else(invalid)?;
    if map
        .keys()
        .any(|k| !matches!(k.as_str(), "path" | "operation" | "limit"))
    {
        return Err(invalid());
    }
    let path = value["path"].as_str().ok_or_else(invalid)?;
    if peer_protocol::javascript_trim(path).is_empty() || path.contains(['\0', '\n']) {
        return Err(invalid());
    }
    if path.len() > limits().path_bytes {
        return Err(GitReadError::new("git_query_path_limit"));
    }
    let operation = map
        .get("operation")
        .map(|v| v.as_str().ok_or_else(invalid))
        .transpose()?
        .unwrap_or(
            contract()["defaults"]["operation"]
                .as_str()
                .expect("compiled default operation"),
        );
    if !matches!(operation, "snapshot" | "status" | "log") {
        return Err(invalid());
    }
    let limit = map
        .get("limit")
        .map(|v| {
            v.as_f64()
                .filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= contract()["manifest"]["inputSchema"]["properties"]["limit"]["minimum"].as_f64().expect("compiled minimum") && *v <= contract()["manifest"]["inputSchema"]["properties"]["limit"]["maximum"].as_f64().expect("compiled maximum"))
                .map(|v| v as u64)
                .ok_or_else(invalid)
        })
        .transpose()?
        .unwrap_or(contract()["defaults"]["limit"].as_u64().expect("compiled default limit"));
    Ok(Input {
        path: path.into(),
        operation: operation.into(),
        limit,
    })
}
struct Query<'a> {
    binary: &'a Path,
    path: PathBuf,
    remaining: usize,
    execution: Duration,
    binding: Vec<String>,
    filters: Vec<String>,
    common: Option<PathBuf>,
    authority: &'a dyn GitReadAuthority,
    cancel: &'a CancellationToken,
}
impl Query<'_> {
    async fn guard(&self) -> Result<(), GitReadError> {
        if self.cancel.is_cancelled() {
            return Err(GitReadError::new("git_query_cancelled"));
        }
        self.authority.check().await
    }
    async fn authorize(&self, path: &Path) -> Result<(), GitReadError> {
        if path.as_os_str().len() > limits().path_bytes {
            return Err(GitReadError::new("git_query_path_limit"));
        }
        self.guard().await?;
        self.authority.authorize(path).await?;
        self.guard().await
    }
    async fn run(&mut self, args: &[&str], codes: &[i32]) -> Result<Output, GitReadError> {
        self.guard().await?;
        let wait = Duration::from_millis(limits().execution_ms)
            .checked_sub(self.execution)
            .ok_or_else(|| GitReadError::new("git_query_timeout"))?;
        if wait.is_zero() {
            return Err(GitReadError::new("git_query_timeout"));
        }
        let started = Instant::now();
        let result = command::run(command::Request {
            binary: self.binary,
            cwd: &self.path,
            binding: &self.binding,
            filters: &self.filters,
            common: self.common.as_deref(),
            args,
            budget: &mut self.remaining,
            wait,
            authority: self.authority,
            cancel: self.cancel,
        })
        .await;
        self.execution += started.elapsed();
        let raw = result?;
        let output = Output {
            code: raw.code,
            stdout: String::from_utf8_lossy(&raw.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&raw.stderr).into_owned(),
        };
        self.guard().await?;
        if !codes.contains(&output.code) {
            return Err(GitReadError::new(
                if output.stderr.contains("not a git repository") {
                    "git_not_repository"
                } else if output.stderr.contains("must be run in a work tree") {
                    "git_worktree_required"
                } else if output.stderr.contains("dubious ownership") {
                    "git_repository_untrusted"
                } else {
                    "git_query_failed"
                },
            ));
        }
        Ok(output)
    }
    async fn identity(&mut self) -> Result<Value, GitReadError> {
        let head = self
            .run(&["rev-parse", "--verify", "--quiet", "HEAD"], &[0, 1])
            .await?;
        let branch = self
            .run(&["symbolic-ref", "--quiet", "--short", "HEAD"], &[0, 1])
            .await?;
        Ok(
            json!({"head":(head.code==0).then(||peer_protocol::javascript_trim(&head.stdout)),"branch":(branch.code==0).then(||branch.stdout.trim_end_matches(|c:char|{let mut b=[0;4];peer_protocol::javascript_trim(c.encode_utf8(&mut b)).is_empty()}))}),
        )
    }
}
async fn canonical(path: PathBuf) -> Result<PathBuf, GitReadError> {
    tokio::task::spawn_blocking(move || std::fs::canonicalize(path))
        .await
        .map_err(|_| GitReadError::new("git_path_not_found"))?
        .map_err(|_| GitReadError::new("git_path_not_found"))
}
fn line(value: &str) -> &str {
    value
        .strip_suffix("\r\n")
        .or_else(|| value.strip_suffix('\n'))
        .unwrap_or(value)
}
impl GitRead {
    pub async fn observe(
        &self,
        value: &Value,
        authority: &dyn GitReadAuthority,
        cancel: &CancellationToken,
    ) -> Result<Value, GitReadError> {
        let input = input(value)?;
        let started = crate::session_host::episode_time();
        if cancel.is_cancelled() {
            return Err(GitReadError::new("git_query_cancelled"));
        }
        let path = canonical(input.path).await?;
        let mut q = Query {
            binary: &self.binary,
            path,
            remaining: limits().raw_bytes,
            execution: Duration::ZERO,
            binding: vec![],
            filters: vec![],
            common: None,
            authority,
            cancel,
        };
        q.authorize(&q.path).await?;
        let top = q.run(&["rev-parse", "--show-toplevel"], &[0]).await?.stdout;
        let repository = canonical(line(&top).into()).await?;
        let git = q
            .run(&["rev-parse", "--absolute-git-dir"], &[0])
            .await?
            .stdout;
        let git = canonical(line(&git).into()).await?;
        let common = q
            .run(&["rev-parse", "--git-common-dir"], &[0])
            .await?
            .stdout;
        let common = canonical(q.path.join(line(&common))).await?;
        let mut paths = Vec::new();
        for path in [&repository, &git, &common] {
            if !paths.contains(&path) {
                q.authorize(path).await?;
                paths.push(path);
            }
        }
        q.binding = vec![
            format!(
                "--git-dir={}",
                git.to_str()
                    .ok_or_else(|| GitReadError::new("git_query_encoding_unsupported"))?
            ),
            format!(
                "--work-tree={}",
                repository
                    .to_str()
                    .ok_or_else(|| GitReadError::new("git_query_encoding_unsupported"))?
            ),
        ];
        q.common = Some(common.clone());
        let config = q
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
            .stdout;
        let fields: Vec<_> = config.split('\0').collect();
        let mut sources = Vec::new();
        for pair in fields.as_chunks::<2>().0 {
            if let Some(source) = pair[0].strip_prefix("file:") {
                let source = canonical(q.path.join(source)).await?;
                if !sources.contains(&source) {
                    if sources.len() >= limits().config_sources {
                        return Err(GitReadError::new("git_query_config_limit"));
                    }
                    q.authorize(&source).await?;
                    sources.push(source);
                }
            }
        }
        let filters = q
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
            .stdout;
        let mut keys = Vec::new();
        for key in filters.split('\0').filter(|s| !s.is_empty()) {
            if !keys.contains(&key) {
                if keys.len() >= limits().filter_keys || key.len() > limits().filter_key_bytes {
                    return Err(GitReadError::new("git_query_filter_limit"));
                }
                keys.push(key);
                q.filters.extend([
                    "-c".to_string(),
                    format!(
                        "{key}={}",
                        if key.ends_with(".required") {
                            "false"
                        } else {
                            ""
                        }
                    ),
                ]);
            }
        }
        let before = q.identity().await?;
        let origins = q
            .run(
                &["config", "--includes", "--get-all", "remote.origin.url"],
                &[0, 1],
            )
            .await?
            .stdout;
        let mut origin = Vec::new();
        let mut fields_truncated = Vec::new();
        for s in origins.split('\n').filter(|s| !s.is_empty()) {
            if origin.len() >= limits().origin_entries {
                return Err(GitReadError::new("git_query_origin_limit"));
            }
            if s.encode_utf16().count() > limits().preview_units
                && !fields_truncated.contains(&"origin")
            {
                fields_truncated.push("origin");
            }
            origin.push(text::origin(s));
        }
        let status_args = [
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=all",
        ];
        let raw = if input.operation != "log" {
            Some(q.run(&status_args, &[0]).await?.stdout)
        } else {
            None
        };
        let mut submodules = 0;
        if raw.is_some() {
            submodules = q
                .run(&["ls-files", "--stage", "-z"], &[0])
                .await?
                .stdout
                .split('\0')
                .filter(|s| s.starts_with("160000 "))
                .count();
        }
        let mut commits = Vec::new();
        if !before["head"].is_null() && input.operation != "status" {
            let count = format!(
                "--max-count={}",
                if input.operation == "log" {
                    input.limit
                } else {
                    1
                }
            );
            let log = q
                .run(
                    &[
                        "log",
                        &count,
                        "--no-decorate",
                        "--format=%H%x00%cI%x00%s%x00",
                    ],
                    &[0],
                )
                .await?
                .stdout;
            let fields: Vec<_> = log.split('\0').collect();
            for f in fields.as_chunks::<3>().0 {
                if commits.len() as u64
                    >= contract()["manifest"]["inputSchema"]["properties"]["limit"]["maximum"]
                        .as_u64()
                        .expect("compiled maximum")
                {
                    return Err(GitReadError::new("git_query_entry_limit"));
                }
                if f[2].encode_utf16().count() > limits().preview_units
                    && !fields_truncated.contains(&"commits.subject")
                {
                    fields_truncated.push("commits.subject");
                }
                commits.push(json!({"hash":peer_protocol::javascript_trim(f[0]),"committedAt":f[1],"subject":text::redact(f[2])}));
            }
        }
        let after = q.identity().await?;
        let mut consistent = before == after;
        if let Some(raw) = &raw {
            consistent = consistent && *raw == q.run(&status_args, &[0]).await?.stdout;
        }
        let mut result = json!({"repositoryPath":repository,"gitDirectory":git,"commonDirectory":common,"configurationSources":sources,"operation":input.operation,"startedAt":started,"finishedAt":crate::session_host::episode_time(),"head":before["head"],"branch":before["branch"],"unborn":before["head"].is_null(),"origin":origin,"consistent":consistent,"atomic":false,"commits":commits});
        if let Some(raw) = raw {
            let mut fields = raw.split('\0').filter(|s| !s.is_empty());
            let mut entries = Vec::new();
            let mut path_bytes = 0usize;
            let mut changed = 0;
            let mut untracked = 0;
            while let Some(row) = fields.next() {
                let b = row.as_bytes();
                if b.len() < 3 || b[2] != b' ' || !b[0].is_ascii() || !b[1].is_ascii() {
                    return Err(GitReadError::new("git_query_failed"));
                }
                if entries.len() >= limits().status_entries {
                    return Err(GitReadError::new("git_query_entry_limit"));
                }
                path_bytes = path_bytes.saturating_add(row.len() - 3);
                if path_bytes > limits().status_path_bytes {
                    return Err(GitReadError::new("git_query_path_limit"));
                }
                let mut entry = json!({"index":(b[0] as char).to_string(),"worktree":(b[1] as char).to_string(),"path":&row[3..]});
                if b[..2].iter().any(|c| b"RC".contains(c)) {
                    let from = fields
                        .next()
                        .ok_or_else(|| GitReadError::new("git_query_failed"))?;
                    path_bytes = path_bytes.saturating_add(from.len());
                    if path_bytes > limits().status_path_bytes {
                        return Err(GitReadError::new("git_query_path_limit"));
                    }
                    entry["from"] = json!(from);
                }
                if b[0] == b'?' {
                    untracked += 1;
                } else {
                    changed += 1;
                }
                entries.push(entry);
            }
            let clean = if !consistent || !keys.is_empty() {
                None
            } else if !entries.is_empty() {
                Some(false)
            } else if submodules > 0 {
                None
            } else {
                Some(true)
            };
            result["status"] = json!({"clean":clean,"filtersDisabled":!keys.is_empty(),"submoduleCount":submodules,"submodulesInspected":false,"changed":changed,"untracked":untracked,"entries":entries,"truncated":false});
        }
        if !fields_truncated.is_empty() {
            result["fieldsTruncated"] = json!(fields_truncated);
        }
        q.guard().await?;
        // Check while serializing, before a large observation copy is allocated.
        serde_json::to_writer(text::JsonLimit(0), &result)
            .map_err(|_| GitReadError::new("git_query_output_limit"))?;
        Ok(result)
    }
}
