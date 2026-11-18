use super::*;
use std::time::Instant;
use std::{fs, os::unix::fs::PermissionsExt, process::Command, sync::Mutex};
struct SlowAdmission;
impl GitReadAuthority for SlowAdmission {
    fn check(&self) -> AuthorityFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn authorize<'a>(&'a self, _: &'a Path) -> AuthorityFuture<'a> {
        self.check()
    }
    fn starting(&self) -> AuthorityFuture<'_> {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(2200)).await;
            Ok(())
        })
    }
}
#[tokio::test]
async fn host_admission_wait_does_not_consume_the_actual_git_execution_window() {
    let f = Fixture::new();
    let mut budget = 1024;
    let started = Instant::now();
    let output = command::run(command::Request {
        binary: Path::new("/usr/bin/git"),
        cwd: &f.path,
        binding: &[],
        filters: &[],
        common: None,
        args: &["--version"],
        budget: &mut budget,
        deadline: command::Deadline::Execution(Duration::from_secs(2)),
        authority: &SlowAdmission,
        cancel: &CancellationToken::new(),
    })
    .await
    .unwrap();
    assert_eq!(output.code, 0);
    assert!(String::from_utf8_lossy(&output.stdout).contains("git version"));
    assert!(started.elapsed() >= Duration::from_millis(2200));
    assert!(output.execution_elapsed < Duration::from_secs(2));
}

#[tokio::test]
async fn reconciliation_deadline_still_includes_the_same_admission_wait() {
    let f = Fixture::new();
    let mut budget = 1024;
    let result = command::run(command::Request {
        binary: Path::new("/usr/bin/git"),
        cwd: &f.path,
        binding: &[],
        filters: &[],
        common: None,
        args: &["--version"],
        budget: &mut budget,
        deadline: command::Deadline::Total(tokio::time::Instant::now() + Duration::from_secs(2)),
        authority: &SlowAdmission,
        cancel: &CancellationToken::new(),
    })
    .await;
    assert_eq!(result.err().unwrap().code, "git_query_timeout");
}
struct Fixture {
    root: Option<tempfile::TempDir>,
    path: PathBuf,
    home: PathBuf,
    binary: PathBuf,
}
fn quote(value: &Path) -> String {
    format!("'{}'", value.to_str().unwrap().replace('\'', "'\\''"))
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(".native-cli-fixture"), "isolated").unwrap();
        let base = fs::canonicalize(root.path()).unwrap();
        let n = base.to_str().unwrap().len();
        assert!(n < 199);
        let path = base.join("x".repeat(199 - n));
        fs::create_dir(&path).unwrap();
        let home = path.join("home");
        fs::create_dir(&home).unwrap();
        let binary = path.join("owned-git");
        fs::write(&binary,format!("#!/bin/sh\nexport HOME={}\nexport XDG_CONFIG_HOME={}\nexport GIT_CONFIG_NOSYSTEM=1\nexec /usr/bin/git \"$@\"\n",quote(&home),quote(&home.join("config")))).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root: Some(root),
            path,
            home,
            binary,
        }
    }
    fn git(&self, scope: &Path, cwd: &str, args: &[String]) -> String {
        let out = Command::new(&self.binary)
            .args(args)
            .current_dir(scope.join(cwd))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.home)
            .env("GIT_AUTHOR_NAME", "Native Fixture")
            .env("GIT_AUTHOR_EMAIL", "native@example.invalid")
            .env("GIT_COMMITTER_NAME", "Native Fixture")
            .env("GIT_COMMITTER_EMAIL", "native@example.invalid")
            .env("GIT_AUTHOR_DATE", "2026-11-17T00:00:00+05:30")
            .env("GIT_COMMITTER_DATE", "2026-11-17T00:00:00+05:30")
            .env("TZ", "UTC")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().into()
    }
    fn setup(&self, c: &Value) -> PathBuf {
        let scope = self.path.join(c["name"].as_str().unwrap());
        fs::create_dir(&scope).unwrap();
        for action in c["base"]
            .as_array()
            .unwrap()
            .iter()
            .chain(c["actions"].as_array().unwrap())
        {
            if let Some(args) = action["git"].as_array() {
                let args = args
                    .iter()
                    .map(|a| {
                        if a == "<HEAD>" {
                            self.git(&scope, "repo", &["rev-parse".into(), "HEAD".into()])
                        } else {
                            a.as_str().unwrap().into()
                        }
                    })
                    .collect::<Vec<_>>();
                self.git(&scope, action["cwd"].as_str().unwrap_or("."), &args);
            } else if let Some(p) = action["write"].as_str() {
                let p = scope.join(p);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(p, action["content"].as_str().unwrap()).unwrap();
            } else {
                fs::create_dir_all(scope.join(action["mkdir"].as_str().unwrap())).unwrap();
            }
        }
        scope
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // A failed control assertion must not abandon a synthetic descendant.
        if let Ok(pid) = fs::read_to_string(self.path.join("started"))
            && let Ok(pid) = pid.trim().parse::<u32>()
            && !crate::providers::group_absent(pid)
            && let Some(group) = rustix::process::Pid::from_raw(pid as i32)
        {
            let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
        }
        if std::thread::panicking() {
            eprintln!(
                "Preserved owned Git fixture: {}",
                self.root.take().unwrap().keep().display()
            );
        }
    }
}
#[derive(Default)]
struct Authority {
    paths: Mutex<Vec<PathBuf>>,
}
impl GitReadAuthority for Authority {
    fn check(&self) -> AuthorityFuture<'_> {
        Box::pin(async { Ok(()) })
    }
    fn authorize<'a>(&'a self, path: &'a Path) -> AuthorityFuture<'a> {
        Box::pin(async move {
            self.paths.lock().unwrap().push(path.into());
            Ok(())
        })
    }
}
fn normalize(v: &Value, scope: &Path) -> Value {
    match v {
        Value::String(s) => json!(s.replace(scope.to_str().unwrap(), "<root>")),
        Value::Array(a) => Value::Array(a.iter().map(|v| normalize(v, scope)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| {
                    (
                        k.clone(),
                        if matches!(k.as_str(), "startedAt" | "finishedAt" | "completedAt") {
                            json!("<time>")
                        } else {
                            normalize(v, scope)
                        },
                    )
                })
                .collect(),
        ),
        _ => v.clone(),
    }
}
#[tokio::test]
async fn actual_typescript_git_observations_match_native_fixed_commands_and_sources() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/git-query-cases.json"
    ))
    .unwrap();
    let f = Fixture::new();
    let reader = GitRead {
        binary: f.binary.clone(),
    };
    for c in data["vectors"].as_array().unwrap() {
        let scope = f.setup(c);
        let index = if !matches!(c["name"].as_str(), Some("not-repository" | "missing")) {
            Some(scope.join(c["input"]["path"].as_str().unwrap()).join(f.git(
                &scope,
                c["input"]["path"].as_str().unwrap(),
                &["rev-parse".into(), "--git-path".into(), "index".into()],
            )))
        } else {
            None
        };
        let before_index = index.as_ref().and_then(|p| fs::read(p).ok());
        let mut i = c["input"].clone();
        i["path"] = json!(scope.join(i["path"].as_str().unwrap()));
        let authority = Authority::default();
        let observed = reader
            .observe(&i, &authority, &CancellationToken::new())
            .await;
        if let Some(error) = c["engine"]["error"].as_str() {
            assert_eq!(
                observed.unwrap_err(),
                GitReadError::new(error_code(error)),
                "{}",
                c["name"]
            );
        } else {
            let mut observed = observed.unwrap();
            let fields = observed
                .as_object_mut()
                .unwrap()
                .remove("fieldsTruncated")
                .unwrap_or_else(|| json!([]));
            assert_eq!(
                fields, c["nativeFieldsTruncated"],
                "{} truncation facts",
                c["name"]
            );
            assert_eq!(normalize(&observed, &scope), c["engine"], "{}", c["name"]);
        }
        let paths = json!(*authority.paths.lock().unwrap());
        assert_eq!(
            normalize(&paths, &scope),
            c["authorized"],
            "{} authorized",
            c["name"]
        );
        assert!(!scope.join("repo/UNEXPECTED_EXECUTION").exists());
        if let Some(index) = index {
            assert_eq!(
                fs::read(&index).ok(),
                before_index,
                "{} index changed",
                c["name"]
            );
            let lock = PathBuf::from(format!("{}.lock", index.display()));
            assert!(!lock.exists());
        }
    }
}
fn error_code(code: &str) -> &'static str {
    match code {
        "git_not_repository" => "git_not_repository",
        "git_path_not_found" => "git_path_not_found",
        _ => panic!("unknown reference error {code}"),
    }
}
#[test]
fn actual_invalid_inputs_remain_invalid_without_clamping_or_extra_arguments() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/git-query-cases.json"
    ))
    .unwrap();
    for c in data["invalid"].as_array().unwrap() {
        assert_eq!(
            input(c).err().unwrap().code,
            "git_query_invalid_input",
            "{c}"
        );
    }
}
#[test]
fn integral_json_numbers_and_redaction_preserve_javascript_case_and_scalar_boundaries() {
    assert_eq!(
        input(&serde_json::from_str::<Value>(r#"{"path":".","limit":1.0}"#).unwrap())
            .unwrap()
            .limit,
        1
    );
    assert_eq!(
        text::redact("bearer abc.DEF sk-ABCDEFGHIJKLMNOPQRSTUV AUTH_TOKEN=private"),
        "bearer [REDACTED_TOKEN] [REDACTED_API_KEY] AUTH_TOKEN=[REDACTED]"
    );
    let raw = format!("x{}", "🦀".repeat(2000));
    let s = text::redact(&raw);
    assert!(s.starts_with(&format!("x{}", "🦀".repeat(1999))));
    assert!(s.ends_with("\n...[preview truncated]"));
}
struct Revocable {
    revoked: std::sync::atomic::AtomicBool,
}
impl GitReadAuthority for Revocable {
    fn check(&self) -> AuthorityFuture<'_> {
        Box::pin(async move {
            if self.revoked.load(std::sync::atomic::Ordering::Acquire) {
                Err(GitReadError::new("permission_policy_changed"))
            } else {
                Ok(())
            }
        })
    }
    fn authorize<'a>(&'a self, _: &'a Path) -> AuthorityFuture<'a> {
        self.check()
    }
}
#[tokio::test]
async fn command_cancellation_timeout_revocation_and_output_limit_reap_the_real_group() {
    for mode in ["cancel", "timeout", "revoke", "output", "parent-exit"] {
        let f = Fixture::new();
        let ready = f.path.join("started");
        let body = if mode == "output" {
            "/usr/bin/yes oversized"
        } else if mode == "parent-exit" {
            "/bin/sleep 60 &\nexit 0"
        } else {
            "/bin/sleep 60 &\nwait"
        };
        fs::write(
            &f.binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\n/bin/mv -f {} {}\n{body}\n",
                quote(&ready.with_extension("partial")),
                quote(&ready.with_extension("partial")),
                quote(&ready)
            ),
        )
        .unwrap();
        let authority = Revocable {
            revoked: std::sync::atomic::AtomicBool::new(false),
        };
        let cancel = CancellationToken::new();
        let mut budget = if mode == "output" {
            100
        } else {
            8 * 1024 * 1024
        };
        let future = command::run(command::Request {
            binary: &f.binary,
            cwd: &f.path,
            binding: &[],
            filters: &[],
            common: None,
            args: &["status"],
            budget: &mut budget,
            // The real owned interpreter must be observed before checking its
            // group. A150ms deadline can expire during macOS exec startup.
            // Keep the separate3s readiness assertion; product remains15s.
            deadline: command::Deadline::Total(
                tokio::time::Instant::now() + Duration::from_secs(5),
            ),
            authority: &authority,
            cancel: &cancel,
        });
        let observed_future = async {
            let result = future.await;
            if let Err(e) = &result {
                eprintln!("owned Git control {mode}: {e:?}");
            }
            result
        };
        let control = async {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !ready.exists() {
                assert!(
                    Instant::now() < deadline,
                    "{mode} process never wrote its actual ready marker"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            if mode == "cancel" {
                cancel.cancel();
            }
            if mode == "parent-exit" {
                let pid = fs::read_to_string(&ready)
                    .unwrap()
                    .trim()
                    .parse::<i32>()
                    .unwrap();
                while rustix::process::test_kill_process(
                    rustix::process::Pid::from_raw(pid).unwrap(),
                ) != Err(rustix::io::Errno::SRCH)
                {
                    assert!(
                        Instant::now() < deadline,
                        "fixture parent was not actually reaped"
                    );
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                assert!(
                    !crate::providers::group_absent(pid as u32),
                    "descendant must hold pipes after parent reap"
                );
                cancel.cancel();
            }
            if mode == "revoke" {
                authority
                    .revoked
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        };
        let (observed, ()) = tokio::join!(observed_future, control);
        let e = observed.err().unwrap();
        let pid = fs::read_to_string(ready)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        if !e.ended {
            let group = rustix::process::Pid::from_raw(pid as i32).unwrap();
            eprintln!(
                "{mode} owned Git group {pid}, signal-zero probe: {:?}",
                rustix::process::test_kill_process_group(group)
            );
            if let Ok(snapshot) = std::process::Command::new("/bin/ps")
                .args(["-axo", "pid=,ppid=,pgid=,state=,comm="])
                .output()
            {
                let rows = String::from_utf8_lossy(&snapshot.stdout);
                for line in rows
                    .lines()
                    .filter(|line| {
                        line.split_whitespace().nth(2).and_then(|v| v.parse().ok()) == Some(pid)
                    })
                    .take(16)
                {
                    eprintln!("{mode} owned Git member (PID PPID PGID STATE COMMAND): {line}");
                }
            }
        }
        assert!(e.ended, "{mode}: {e:?}");
        assert_eq!(
            e.code,
            match mode {
                "cancel" | "parent-exit" => "git_query_cancelled",
                "timeout" => "git_query_timeout",
                "revoke" => "permission_policy_changed",
                _ => "git_query_output_limit",
            }
        );
        assert!(
            crate::providers::group_absent(pid),
            "{mode} group remains after observation returned"
        );
    }
}
