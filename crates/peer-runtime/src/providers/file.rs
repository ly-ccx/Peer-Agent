use super::*;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom, Write},
    sync::{Arc, Mutex},
};
type Snapshots = Arc<Mutex<HashMap<PathBuf, String>>>;
#[derive(Default)]
pub(super) struct FileProvider {
    snapshots: Snapshots,
}
struct FileEffect {
    args: Value,
    path: PathBuf,
    write: bool,
    snapshots: Snapshots,
}
fn read_handle(file: &mut std::fs::File) -> Result<(String, String), HostError> {
    if !file
        .metadata()
        .map_err(|_| HostError("file_unavailable"))?
        .is_file()
    {
        return Err(HostError("not_a_file"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(file)
        .take(128 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| HostError("file_read_failed"))?;
    if bytes.len() > 128 * 1024 {
        return Err(HostError("file_too_large"));
    }
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let text = String::from_utf8(bytes).map_err(|_| HostError("file_not_utf8"))?;
    Ok((text, hash))
}
fn read(path: &Path) -> Result<(String, String), HostError> {
    read_handle(&mut std::fs::File::open(path).map_err(|_| HostError("file_unavailable"))?)
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
                (
                    if m["capabilityId"] == "local.file.read" {
                        "read_file"
                    } else {
                        "write_file"
                    }
                    .into(),
                    m.clone(),
                )
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
        let write = capability == "local.file.write";
        if !write && capability != "local.file.read" {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(
            &args,
            if write {
                &["path", "content", "allow_overwrite"]
            } else {
                &["path", "start_line", "end_line"]
            },
        )?;
        let path = resolve(workspace, string(&args, "path")?)?;
        if write {
            if string(&args, "content")?.len() > 32768 {
                return Err(HostError("file_write_too_large"));
            }
            if args.get("allow_overwrite").is_some_and(|v| !v.is_boolean()) {
                return Err(HostError("tool_arguments_invalid"));
            }
        } else {
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
        Ok(Box::new(FileEffect {
            args,
            path,
            write,
            snapshots: self.snapshots.clone(),
        }))
    }
}
impl PreparedEffect for FileEffect {
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        if self.write {
            ProviderPermission::FileWrite
        } else {
            ProviderPermission::Read
        }
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        if self.write {
            peer_store::provider_file_scopes(&self.path).map_err(Into::into)
        } else {
            Ok(vec![])
        }
    }
    fn start(
        self: Box<Self>,
        host: &NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let mut materialization = None;
        let result = (|| {
            if self.write {
                let before = if self.path.exists() {
                    Some(read(&self.path)?.1)
                } else {
                    None
                };
                if let Some(hash) = &before
                    && (self.args["allow_overwrite"] != true
                        || self
                            .snapshots
                            .lock()
                            .map_err(|_| HostError("file_snapshot_unavailable"))?
                            .get(&self.path)
                            != Some(hash))
                {
                    return Err(HostError("file_read_required_or_changed"));
                }
                let content = string(&self.args, "content")?;
                host.validate_permission(grant, &self.args, now)?;
                let mut flags = rustix::fs::OFlags::RDWR
                    | rustix::fs::OFlags::NOFOLLOW
                    | rustix::fs::OFlags::CLOEXEC;
                if before.is_none() {
                    flags |= rustix::fs::OFlags::CREATE | rustix::fs::OFlags::EXCL
                }
                let fd =
                    rustix::fs::open(&self.path, flags, rustix::fs::Mode::from_raw_mode(0o666))
                        .map_err(|_| HostError("file_write_failed"))?;
                let mut file = std::fs::File::from(fd);
                if let Some(hash) = &before {
                    if read_handle(&mut file)?.1 != *hash {
                        return Err(HostError("file_changed"));
                    }
                    file.seek(SeekFrom::Start(0))
                        .map_err(|_| HostError("file_write_failed"))?;
                    if cancel.is_cancelled() {
                        return Err(HostError("CANCELLED"));
                    }
                    host.validate_permission(grant, &self.args, now)?;
                }
                // Match the existing Provider's in-place target semantics. No
                // hidden temporary paths can escape the declared file scope.
                file.set_len(0)
                    .and_then(|_| file.write_all(content.as_bytes()))
                    .and_then(|_| file.sync_all())
                    .map_err(|_| HostError("execution_outcome_unknown"))?;
                std::fs::File::open(self.path.parent().unwrap())
                    .and_then(|d| d.sync_all())
                    .map_err(|_| HostError("execution_outcome_unknown"))?;
                if before.is_none() {
                    use std::os::unix::fs::MetadataExt;
                    let meta = file
                        .metadata()
                        .map_err(|_| HostError("execution_outcome_unknown"))?;
                    let observed = peer_store::file_resource(&self.path, false)
                        .map_err(|_| HostError("execution_outcome_unknown"))?;
                    if observed.identity != format!("{}:{}", meta.dev(), meta.ino()) {
                        return Err(HostError("execution_outcome_unknown"));
                    }
                    materialization = Some(observed);
                }
                let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
                let mut snapshots = self
                    .snapshots
                    .lock()
                    .map_err(|_| HostError("execution_outcome_unknown"))?;
                if snapshots.len() >= 128 && !snapshots.contains_key(&self.path) {
                    snapshots.clear();
                }
                snapshots.insert(self.path.clone(), hash.clone());
                Ok(json!({"path":self.path,"bytes":content.len(),"contentHash":hash}))
            } else {
                host.validate_permission(grant, &self.args, now)?;
                let (text, hash) = read(&self.path)?;
                let mut output = slice_lines(&text, &self.args)?;
                output["path"] = json!(self.path);
                let mut snapshots = self
                    .snapshots
                    .lock()
                    .map_err(|_| HostError("file_snapshot_unavailable"))?;
                if snapshots.len() >= 128 && !snapshots.contains_key(&self.path) {
                    return Err(HostError("file_snapshot_limit"));
                }
                snapshots.insert(self.path.clone(), hash);
                Ok(output)
            }
        })();
        let output = match result {
            Ok(output) => EffectOutcome {
                status: "success",
                output,
                error: None,
                artifacts: vec![],
                ended: true,
                materialization,
            },
            Err(e) => EffectOutcome::failed(e.0),
        };
        Ok(Box::pin(async move { output }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
