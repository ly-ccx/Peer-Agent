//! A write binds its existing ancestor before admission. Missing parents are
//! created through that directory's descriptors, never a second path executor.
use super::*;
use std::{ffi::OsString, os::unix::fs::MetadataExt, path::Component};
pub(super) const PARENTS: usize = 128;
pub(super) struct Target {
    anchor: PathBuf,
    identity: (u64, u64),
    missing: Vec<OsString>,
    leaf: OsString,
}
pub(super) struct Parent {
    path: PathBuf,
    file: std::fs::File,
    leaf: OsString,
}
fn identity(f: &std::fs::File) -> Result<(u64, u64), HostError> {
    let m = f
        .metadata()
        .map_err(|_| HostError("file_parent_unavailable"))?;
    Ok((m.dev(), m.ino()))
}
fn flags() -> rustix::fs::OFlags {
    use rustix::fs::OFlags as O;
    O::RDONLY | O::DIRECTORY | O::NOFOLLOW | O::CLOEXEC | O::NONBLOCK
}
fn directory(path: &Path) -> Result<std::fs::File, HostError> {
    let mut file = std::fs::File::from(
        rustix::fs::open("/", flags(), rustix::fs::Mode::empty())
            .map_err(|_| HostError("file_parent_unavailable"))?,
    );
    for c in path.components() {
        match c {
            Component::RootDir => (),
            Component::Normal(name) => {
                file = rustix::fs::openat(&file, name, flags(), rustix::fs::Mode::empty())
                    .map(std::fs::File::from)
                    .map_err(|_| HostError("file_parent_changed"))?;
            }
            _ => return Err(HostError("invalid_path")),
        }
    }
    Ok(file)
}
pub(super) fn resolve_write(workspace: &Path, input: &str) -> Result<PathBuf, HostError> {
    if input.trim().is_empty() || input.len() > 16384 || input.contains('\0') {
        return Err(HostError("invalid_path"));
    }
    let p = Path::new(input.trim());
    let p = if p.is_absolute() {
        p.to_owned()
    } else {
        workspace.join(p)
    };
    // Use the same lexical/real ancestor identity as ResourceLedger (and TS
    // path.resolve), including aliases such as /var -> /private/var on macOS.
    match peer_store::provider_file_scopes(p)?.pop() {
        Some(ExecutionResourceScope::File { path }) => Ok(path.into()),
        _ => Err(HostError("invalid_path")),
    }
}
impl Target {
    pub(super) fn inspect(path: &Path) -> Result<Self, HostError> {
        if !path.is_absolute() {
            return Err(HostError("invalid_path"));
        }
        let mut anchor = path.parent().ok_or(HostError("invalid_path"))?.to_owned();
        let mut missing = vec![];
        loop {
            match std::fs::symlink_metadata(&anchor) {
                Ok(m) if m.is_dir() => break,
                Ok(_) => return Err(HostError("file_parent_unavailable")),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    missing.push(
                        anchor
                            .file_name()
                            .ok_or(HostError("invalid_path"))?
                            .to_owned(),
                    );
                    if missing.len() > PARENTS {
                        return Err(HostError("file_parent_limit"));
                    }
                    if !anchor.pop() {
                        return Err(HostError("invalid_path"));
                    }
                }
                Err(_) => return Err(HostError("file_parent_unavailable")),
            }
        }
        let observed = directory(&anchor)?;
        Ok(Self {
            anchor,
            identity: identity(&observed)?,
            missing,
            leaf: path
                .file_name()
                .ok_or(HostError("invalid_path"))?
                .to_owned(),
        })
    }
    pub(super) fn scopes(&self, path: &Path) -> Result<Vec<ExecutionResourceScope>, HostError> {
        let mut scopes = peer_store::provider_file_scopes(path)?;
        if !self.missing.is_empty() {
            scopes.push(ExecutionResourceScope::Directory {
                path: self
                    .anchor
                    .to_str()
                    .ok_or(HostError("invalid_path"))?
                    .into(),
            });
        }
        Ok(scopes)
    }
    pub(super) fn open(&self, run: &RunGuard, changed: &mut bool) -> Result<Parent, HostError> {
        run.check()?;
        let file = directory(&self.anchor)?;
        if identity(&file)? != self.identity {
            return Err(HostError("file_parent_changed"));
        }
        let mut parent = Parent {
            path: self.anchor.clone(),
            file,
            leaf: self.leaf.clone(),
        };
        for name in self.missing.iter().rev() {
            run.check()?;
            parent.verify()?;
            match rustix::fs::mkdirat(&parent.file, name, rustix::fs::Mode::from_raw_mode(0o777)) {
                Ok(()) => {
                    *changed = true;
                    parent
                        .file
                        .sync_all()
                        .map_err(|_| HostError("execution_outcome_unknown"))?;
                }
                Err(rustix::io::Errno::EXIST) => (),
                Err(e) => {
                    return Err(HostError(
                        if matches!(e, rustix::io::Errno::IO | rustix::io::Errno::INTR) {
                            "execution_outcome_unknown"
                        } else {
                            "file_parent_unavailable"
                        },
                    ));
                }
            }
            let file = rustix::fs::openat(&parent.file, name, flags(), rustix::fs::Mode::empty())
                .map(std::fs::File::from)
                .map_err(|_| HostError("file_parent_changed"))?;
            parent.path.push(name);
            parent.file = file;
        }
        run.check()?;
        parent.verify()?;
        Ok(parent)
    }
}
impl Parent {
    pub(super) fn verify(&self) -> Result<(), HostError> {
        if identity(&directory(&self.path)?)? != identity(&self.file)? {
            return Err(HostError("file_parent_changed"));
        }
        Ok(())
    }
    pub(super) fn open_leaf(&self, create: bool) -> Result<std::fs::File, HostError> {
        self.verify()?;
        use rustix::fs::OFlags as O;
        let mut flags = O::RDWR | O::NOFOLLOW | O::CLOEXEC | O::NONBLOCK;
        if create {
            flags |= O::CREATE | O::EXCL;
        }
        rustix::fs::openat(
            &self.file,
            &self.leaf,
            flags,
            rustix::fs::Mode::from_raw_mode(0o666),
        )
        .map(std::fs::File::from)
        .map_err(|e| {
            HostError(
                if create && matches!(e, rustix::io::Errno::IO | rustix::io::Errno::INTR) {
                    "execution_outcome_unknown"
                } else {
                    "file_unavailable"
                },
            )
        })
    }
    pub(super) fn sync(&self) -> Result<(), HostError> {
        self.file
            .sync_all()
            .map_err(|_| HostError("execution_outcome_unknown"))?;
        self.verify()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Clone, Copy)]
    enum Action {
        Success,
        CancelBefore,
        ReplaceAnchor,
        DenyAfterDirectory,
        CancelAfterDirectory,
        SymlinkAfterDirectory,
        ReplaceDirectory,
    }
    #[tokio::test]
    async fn real_directory_descriptors_preserve_effects_and_refuse_revocation_or_replacement() {
        for action in [
            Action::Success,
            Action::CancelBefore,
            Action::ReplaceAnchor,
            Action::DenyAfterDirectory,
            Action::CancelAfterDirectory,
            Action::SymlinkAfterDirectory,
            Action::ReplaceDirectory,
        ] {
            let home = tempfile::tempdir().unwrap();
            let root = std::fs::canonicalize(home.path()).unwrap();
            let workspace = root.join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            std::fs::create_dir(root.join("outside")).unwrap();
            let path = workspace.join("new/deep/out.txt");
            let target = Target::inspect(&path).unwrap();
            assert_eq!(
                target.scopes(&path).unwrap(),
                vec![
                    ExecutionResourceScope::File {
                        path: path.to_str().unwrap().into()
                    },
                    ExecutionResourceScope::Directory {
                        path: workspace.to_str().unwrap().into()
                    }
                ]
            );
            let effect = FileEffect {
                args: json!({"path":"new/deep/out.txt","content":"actual content"}),
                path: path.clone(),
                workspace: workspace.clone(),
                operation: Operation::Write,
                snapshots: Default::default(),
                target: Some(target),
                port: None,
                #[cfg(feature = "test-fixtures")]
                test_root: root.clone(),
            };
            let cancel = CancellationToken::new();
            let (port, mut receive) = EffectAdmission::channel(&cancel);
            let control_cancel = cancel.clone();
            let runtime = tokio::runtime::Handle::current();
            let task = tokio::task::spawn_blocking(move || {
                let mut materialization = None;
                let result = effect.perform(
                    &RunGuard {
                        cancel,
                        port,
                        runtime,
                    },
                    &mut materialization,
                );
                (result, materialization)
            });
            let watched = workspace.clone();
            let retained = root.join("retained");
            let control = async {
                let mut checks = 0;
                let mut applied = false;
                while let Some(request) = receive.recv().await {
                    let crate::effect_admission::AdmissionRequest::Check(reply) = request else {
                        panic!("unexpected child admission")
                    };
                    checks += 1;
                    let mut result = Ok(());
                    if !applied {
                        match action {
                            Action::CancelBefore => {
                                control_cancel.cancel();
                                applied = true;
                            }
                            Action::ReplaceAnchor if checks == 3 => {
                                std::fs::rename(&watched, &retained).unwrap();
                                std::fs::create_dir(&watched).unwrap();
                                applied = true;
                            }
                            Action::DenyAfterDirectory if watched.join("new").exists() => {
                                result = Err(HostError("permission_policy_changed"));
                                applied = true;
                            }
                            Action::CancelAfterDirectory if watched.join("new").exists() => {
                                control_cancel.cancel();
                                applied = true;
                            }
                            Action::SymlinkAfterDirectory if watched.join("new").exists() => {
                                std::fs::rename(watched.join("new"), &retained).unwrap();
                                std::os::unix::fs::symlink(
                                    root.join("outside"),
                                    watched.join("new"),
                                )
                                .unwrap();
                                applied = true;
                            }
                            Action::ReplaceDirectory if watched.join("new").exists() => {
                                std::fs::rename(watched.join("new"), &retained).unwrap();
                                std::fs::create_dir(watched.join("new")).unwrap();
                                applied = true;
                            }
                            _ => (),
                        }
                    }
                    let _ = reply.send(result);
                }
                assert!(applied || matches!(action, Action::Success));
            };
            let (result, ()) = tokio::join!(task, control);
            let (result, materialization) = result.unwrap();
            match action {
                Action::Success => {
                    assert!(result.is_ok());
                    assert!(materialization.is_some());
                    assert_eq!(std::fs::read_to_string(&path).unwrap(), "actual content");
                }
                Action::CancelBefore => {
                    assert_eq!(result.unwrap_err().0, "CANCELLED");
                    assert!(!workspace.join("new").exists());
                }
                Action::ReplaceAnchor => {
                    assert_eq!(result.unwrap_err().0, "file_parent_changed");
                    assert!(!workspace.join("new").exists());
                    assert!(!retained.join("new").exists());
                }
                _ => {
                    assert_eq!(result.unwrap_err().0, "execution_outcome_unknown");
                    assert!(workspace.join("new").exists());
                    assert!(!path.exists());
                    assert!(materialization.is_none());
                }
            }
            assert!(
                std::fs::read_dir(root.join("outside"))
                    .unwrap()
                    .next()
                    .is_none()
            );
        }
    }
    #[test]
    fn missing_directory_limit_is_registered_and_inspection_never_creates() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/file-parents.json"
        ))
        .unwrap();
        assert_eq!(data["nativeLimits"]["missingParentDirectories"], PARENTS);
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        // Keep the TempDir owner alive for both inspections.
        let allowed = root.join(format!("{}out.txt", "a/".repeat(PARENTS)));
        assert_eq!(Target::inspect(&allowed).unwrap().missing.len(), PARENTS);
        let denied = root.join(format!("{}out.txt", "a/".repeat(PARENTS + 1)));
        assert_eq!(
            Target::inspect(&denied).err().unwrap().0,
            "file_parent_limit"
        );
        assert!(!root.join("a").exists());
    }
}
