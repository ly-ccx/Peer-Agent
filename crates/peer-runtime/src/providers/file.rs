use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};
mod edit;
mod locale;
mod scan;
mod target;
mod write;
const READ_BYTES: usize = 2_000_000;
const WRITE_BYTES: usize = 128 * 1024;
const SNAPSHOT_ENTRIES: usize = 128;
type Snapshots = Arc<Mutex<HashMap<PathBuf, String>>>;
#[derive(Default)]
pub(super) struct FileProvider {
    snapshots: Snapshots,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Read,
    List,
    Search,
    Write,
    Edit,
}
impl Operation {
    fn write(self) -> bool {
        matches!(self, Self::Write | Self::Edit)
    }
}
struct FileEffect {
    args: Value,
    path: PathBuf,
    workspace: PathBuf,
    operation: Operation,
    snapshots: Snapshots,
    target: Option<target::Target>,
    port: Option<EffectAdmission>,
    #[cfg(feature = "test-fixtures")]
    test_root: PathBuf,
}
struct RunGuard {
    cancel: CancellationToken,
    port: EffectAdmission,
    runtime: tokio::runtime::Handle,
}
impl RunGuard {
    fn cancel(&self) -> Result<(), HostError> {
        if self.cancel.is_cancelled() {
            Err(HostError("CANCELLED"))
        } else {
            Ok(())
        }
    }
    fn check(&self) -> Result<(), HostError> {
        self.cancel()?;
        self.runtime.block_on(self.port.check())
    }
}
fn open_file(path: &Path) -> Result<std::fs::File, HostError> {
    let flags = rustix::fs::OFlags::RDONLY
        | rustix::fs::OFlags::NOFOLLOW
        | rustix::fs::OFlags::CLOEXEC
        | rustix::fs::OFlags::NONBLOCK;
    rustix::fs::open(path, flags, rustix::fs::Mode::from_raw_mode(0o666))
        .map(std::fs::File::from)
        .map_err(|_| HostError("file_unavailable"))
}
fn read_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, HostError> {
    read_handle_bytes(&mut open_file(path)?, limit)
}
fn read_handle_bytes(file: &mut std::fs::File, limit: usize) -> Result<Vec<u8>, HostError> {
    if !file
        .metadata()
        .map_err(|_| HostError("file_unavailable"))?
        .is_file()
    {
        return Err(HostError("not_a_file"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError("file_read_failed"))?;
    if bytes.len() > limit {
        return Err(HostError("file_too_large"));
    }
    Ok(bytes)
}
fn read_handle(file: &mut std::fs::File) -> Result<(String, String), HostError> {
    let bytes = read_handle_bytes(file, READ_BYTES)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    Ok((
        String::from_utf8(bytes).map_err(|_| HostError("file_not_utf8"))?,
        hash,
    ))
}
fn read(path: &Path) -> Result<(String, String), HostError> {
    read_handle(&mut open_file(path)?)
}
pub(super) fn slice_lines(content: &str, args: &Value) -> Result<Value, HostError> {
    let mut lines: Vec<_> = if content.is_empty() {
        vec![]
    } else {
        content.split('\n').collect()
    };
    if content.ends_with('\n') {
        lines.pop();
    }
    let ranged = args.get("start_line").is_some() || args.get("end_line").is_some();
    if !ranged {
        return Ok(
            json!({"content":content,"startLine":if lines.is_empty(){0}else{1},"endLine":lines.len(),"totalLines":lines.len(),"ranged":false}),
        );
    }
    let start = args["start_line"].as_u64().unwrap_or(1);
    let end = args["end_line"]
        .as_u64()
        .unwrap_or(lines.len() as u64)
        .min(lines.len() as u64);
    if start > lines.len() as u64 && (!lines.is_empty() || start > 1) {
        return Err(HostError("start_line_out_of_range"));
    }
    let width = end.to_string().len();
    let content = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| *i + 1 >= start as usize && *i < end as usize)
        .map(|(i, s)| format!("{:>width$}\t{}", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(
        json!({"content":content,"startLine":start,"endLine":end,"totalLines":lines.len(),"ranged":true}),
    )
}

impl CapabilityProvider for FileProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        file_manifests()
            .as_array()
            .unwrap()
            .iter()
            .map(|m| {
                let alias = match m["capabilityId"].as_str().unwrap() {
                    "local.file.read" => "read_file",
                    "local.file.list" => "list_files",
                    "local.file.search" => "search_files",
                    "local.file.edit" => "edit_file",
                    "local.file.write" => "write_file",
                    _ => unreachable!("compiled file manifest"),
                };
                (alias.into(), m.clone())
            })
            .collect()
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        let operation = match capability {
            "local.file.read" => Operation::Read,
            "local.file.list" => Operation::List,
            "local.file.search" => Operation::Search,
            "local.file.edit" => Operation::Edit,
            "local.file.write" => Operation::Write,
            _ => return Err(HostError("tool_not_projected")),
        };
        validate_shape(
            &args,
            match operation {
                Operation::Read => &["path", "start_line", "end_line"],
                Operation::List => &["path"],
                Operation::Search => &["path", "query", "case_sensitive", "max_results"],
                Operation::Edit => &["path", "old_string", "new_string", "replace_all"],
                Operation::Write => &["path", "content", "allow_overwrite"],
            },
        )?;
        let resolve = if operation == Operation::Write {
            target::resolve_write
        } else {
            resolve
        };
        let path = resolve(
            workspace,
            if operation == Operation::Search && args.get("path").is_none() {
                "."
            } else {
                string(&args, "path")?
            },
        )?;
        match operation {
            Operation::Write => {
                if string(&args, "content")?.len() > WRITE_BYTES {
                    return Err(HostError("file_write_too_large"));
                }
                if args.get("allow_overwrite").is_some_and(|v| !v.is_boolean()) {
                    return Err(HostError("tool_arguments_invalid"));
                }
            }
            Operation::Edit => {
                string(&args, "old_string")?;
                string(&args, "new_string")?;
                if args.get("replace_all").is_some_and(|v| !v.is_boolean()) {
                    return Err(HostError("tool_arguments_invalid"));
                }
            }
            Operation::Search => {
                string(&args, "query")?;
                if args.get("case_sensitive").is_some_and(|v| !v.is_boolean())
                    || args.get("max_results").is_some_and(|v| !v.is_number())
                {
                    return Err(HostError("tool_arguments_invalid"));
                }
            }
            Operation::Read => {
                for key in ["start_line", "end_line"] {
                    if args.get(key).is_some_and(|v| {
                        v.as_u64()
                            .is_none_or(|n| n == 0 || n > 9_007_199_254_740_991)
                    }) {
                        return Err(HostError("invalid_line_range"));
                    }
                }
                if args["end_line"]
                    .as_u64()
                    .zip(args["start_line"].as_u64())
                    .is_some_and(|(e, s)| e < s)
                {
                    return Err(HostError("invalid_line_range"));
                }
            }
            Operation::List => {}
        }
        let target = operation
            .write()
            .then(|| target::Target::inspect(&path))
            .transpose()?;
        Ok(Box::new(FileEffect {
            args,
            path,
            // Match the canonicalized target's namespace as well (macOS /var
            // is an alias of /private/var); presentation remains workspace-relative.
            workspace: std::fs::canonicalize(workspace)
                .map_err(|_| HostError("file_unavailable"))?,
            operation,
            snapshots: self.snapshots.clone(),
            target,
            port: None,
            #[cfg(feature = "test-fixtures")]
            test_root: _home.into(),
        }))
    }
}
impl FileEffect {
    fn remember(&self, hash: String, after_write: bool) -> Result<(), HostError> {
        let mut snapshots = self.snapshots.lock().map_err(|_| {
            HostError(if after_write {
                "execution_outcome_unknown"
            } else {
                "file_snapshot_unavailable"
            })
        })?;
        if snapshots.len() >= SNAPSHOT_ENTRIES && !snapshots.contains_key(&self.path) {
            if after_write {
                snapshots.clear();
            } else {
                return Err(HostError("file_snapshot_limit"));
            }
        }
        snapshots.insert(self.path.clone(), hash);
        Ok(())
    }
    fn perform(
        &self,
        run: &RunGuard,
        materialization: &mut Option<peer_store::ResourceIdentity>,
    ) -> Result<Value, HostError> {
        run.check()?;
        #[cfg(feature = "test-fixtures")]
        if self.operation == Operation::Edit
            && self.test_root.join(".native-cli-fixture").is_file()
            && std::env::var("PEER_NATIVE_FILE_BARRIER").as_deref() == Ok("edit")
        {
            std::fs::write(self.test_root.join("file-worker-ready"), "owned")
                .map_err(|_| HostError("fixture_barrier_unavailable"))?;
            while !self.test_root.join("file-worker-resume").exists() {
                run.cancel()?;
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            run.check()?;
        }
        match self.operation {
            Operation::List => return scan::list(&self.path, &self.workspace, run),
            Operation::Search => return scan::search(&self.path, &self.workspace, &self.args, run),
            Operation::Read => {
                let (text, hash) = read(&self.path)?;
                let slice = slice_lines(&text, &self.args)?;
                run.check()?;
                let mut output = json!({"path":scan::display(&self.workspace,&self.path),"content":slice["content"],"bytes":text.len(),"contentHash":hash});
                if slice["ranged"] == true {
                    output["start_line"] = slice["startLine"].clone();
                    output["end_line"] = slice["endLine"].clone();
                    output["total_lines"] = slice["totalLines"].clone();
                }
                self.remember(hash, false)?;
                return Ok(output);
            }
            Operation::Write | Operation::Edit => {}
        }
        self.write(run, materialization)
    }
}
impl PreparedEffect for FileEffect {
    fn output_kind(&self) -> ToolOutputKind {
        if self.operation == Operation::Read {
            ToolOutputKind::FileRead
        } else {
            ToolOutputKind::Structured
        }
    }

    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        if self.operation.write() {
            ProviderPermission::FileWrite
        } else {
            ProviderPermission::Read
        }
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        if self.operation.write() {
            self.target
                .as_ref()
                .ok_or(HostError("file_parent_unavailable"))?
                .scopes(&self.path)
        } else {
            Ok(vec![])
        }
    }
    fn start(
        mut self: Box<Self>,
        host: &mut NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        host.validate_permission(grant, &self.args, now)?;
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        let run = RunGuard {
            cancel,
            port,
            runtime: tokio::runtime::Handle::current(),
        };
        let write = self.operation.write();
        let is_read = self.operation == Operation::Read;
        Ok(Box::pin(async move {
            let task = tokio::task::spawn_blocking(move || {
                let mut materialization = None;
                let result = self.perform(&run, &mut materialization).and_then(|v| {
                    if !is_read {
                        scan::bounded(&v)?;
                    }
                    Ok(v)
                });
                match result {
                    Ok(output) => EffectOutcome {
                        status: "success",
                        output,
                        error: None,
                        artifacts: vec![],
                        ended: true,
                        materialization,
                        not_dispatched: false,
                    },
                    Err(e) => {
                        let mut out = EffectOutcome::failed(e.0);
                        if e.0 == "CANCELLED" {
                            out.status = "cancelled";
                        }
                        out
                    }
                }
            });
            // Await the actual worker even on cancellation; dropping its JoinHandle does
            // not prove a blocking OS operation ended.
            task.await.unwrap_or_else(|_| {
                EffectOutcome::failed(if write {
                    "execution_outcome_unknown"
                } else {
                    "file_task_failed"
                })
            })
        }))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_file_limits_match_the_registered_contract() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/file-operations.json"
        ))
        .unwrap();
        assert_eq!(data["nativeRuntime"]["version"], 2);
        assert_eq!(
            data["nativeRuntime"]["limits"],
            json!({"readBytes":READ_BYTES,"writeBytes":WRITE_BYTES,"snapshotEntries":SNAPSHOT_ENTRIES,"collectionItems":scan::ITEMS,"collectionPathBytes":scan::PATH_BYTES,"searchFileBytes":scan::SEARCH_BYTES,"resultBytes":scan::RESULT_BYTES})
        );
    }
    #[tokio::test]
    async fn revocation_after_create_preserves_the_empty_file_as_unknown() {
        let home = tempfile::tempdir().unwrap();
        let target = std::fs::canonicalize(home.path())
            .unwrap()
            .join("created.txt");
        let effect = FileEffect {
            args: json!({"path":"created.txt","content":"never written"}),
            path: target.clone(),
            workspace: home.path().into(),
            operation: Operation::Write,
            snapshots: Default::default(),
            target: Some(target::Target::inspect(&target).unwrap()),
            port: None,
            #[cfg(feature = "test-fixtures")]
            test_root: home.path().into(),
        };
        let cancel = CancellationToken::new();
        let (port, mut receive) = EffectAdmission::channel(&cancel);
        let watched = target.clone();
        let runtime = tokio::runtime::Handle::current();
        let operation = tokio::task::spawn_blocking(move || {
            let run = RunGuard {
                cancel,
                port,
                runtime,
            };
            effect.perform(&run, &mut None)
        });
        let authority = async move {
            while let Some(request) = receive.recv().await {
                match request {
                    crate::effect_admission::AdmissionRequest::Check(reply) => {
                        let _ = reply.send(if watched.exists() {
                            Err(HostError("permission_policy_changed"))
                        } else {
                            Ok(())
                        });
                    }
                    _ => panic!("unexpected file control request"),
                }
            }
        };
        let (result, ()) = tokio::join!(operation, authority);
        assert_eq!(result.unwrap().unwrap_err().0, "execution_outcome_unknown");
        assert!(target.exists());
        assert_eq!(std::fs::read(target).unwrap(), Vec::<u8>::new());
    }
    #[tokio::test]
    async fn oversized_v2_read_never_creates_a_write_snapshot() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("oversized.txt");
        std::fs::write(&path, vec![b'x'; READ_BYTES + 1]).unwrap();
        let snapshots: Snapshots = Default::default();
        let observed = snapshots.clone();
        let effect = FileEffect {
            args: json!({"path":"oversized.txt"}),
            path,
            workspace: home.path().into(),
            operation: Operation::Read,
            snapshots,
            target: None,
            port: None,
            #[cfg(feature = "test-fixtures")]
            test_root: home.path().into(),
        };
        let cancel = CancellationToken::new();
        let (port, mut receive) = EffectAdmission::channel(&cancel);
        let runtime = tokio::runtime::Handle::current();
        let task = tokio::task::spawn_blocking(move || {
            effect.perform(
                &RunGuard {
                    cancel,
                    port,
                    runtime,
                },
                &mut None,
            )
        });
        let authority = async move {
            while let Some(request) = receive.recv().await {
                match request {
                    crate::effect_admission::AdmissionRequest::Check(reply) => {
                        let _ = reply.send(Ok(()));
                    }
                    _ => panic!("unexpected read control"),
                }
            }
        };
        let (result, ()) = tokio::join!(task, authority);
        assert_eq!(result.unwrap().unwrap_err().0, "file_too_large");
        assert!(observed.lock().unwrap().is_empty());
    }
    #[test]
    fn actual_node_locale_order_and_case_mapping_match() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/file-operations.json"
        ))
        .unwrap();
        for c in data["locales"].as_array().unwrap() {
            let raw = ["LC_ALL", "LC_MESSAGES", "LANG"]
                .iter()
                .find_map(|key| c["env"][*key].as_str())
                .unwrap_or("");
            let locale = locale::FileLocale::new(raw).unwrap();
            let mut names = vec!["Z", "a", "A", "ä", "Å", "é", "中", "🙂"];
            names.sort_by(|a, b| locale.compare(a, b));
            assert_eq!(json!(names), c["expected"]["sort"], "{raw}");
            assert_eq!(locale.lower("IİΣΟΣ"), c["expected"]["lower"], "{raw}");
        }
    }
    #[test]
    fn actual_file_range_numbering_and_empty_paths_match() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/native-context-wire.json"
        ))
        .unwrap();
        for c in f["rangeCases"].as_array().unwrap() {
            let result = slice_lines(c["content"].as_str().unwrap(), &c["input"]);
            if let Some(e) = c["error"].as_str() {
                assert_eq!(result.unwrap_err().0, e)
            } else {
                assert_eq!(result.unwrap(), c["expected"])
            }
        }
    }
}
