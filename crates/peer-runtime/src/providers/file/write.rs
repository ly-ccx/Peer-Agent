//! Preparation effects and file publication share one Grant and unknown fence.
use super::*;
impl FileEffect {
    pub(super) fn write(
        &self,
        run: &RunGuard,
        materialization: &mut Option<peer_store::ResourceIdentity>,
    ) -> Result<Value, HostError> {
        let mut changed = false;
        self.write_inner(run, materialization, &mut changed)
            .map_err(|e| {
                if changed {
                    HostError("execution_outcome_unknown")
                } else {
                    e
                }
            })
    }
    fn write_inner(
        &self,
        run: &RunGuard,
        materialization: &mut Option<peer_store::ResourceIdentity>,
        changed: &mut bool,
    ) -> Result<Value, HostError> {
        let previous = if self.path.exists() {
            Some(read(&self.path)?)
        } else {
            None
        };
        if self.operation == Operation::Edit && previous.is_none() {
            return Err(HostError("file_not_found"));
        }
        if let Some((_, hash)) = &previous {
            let snapshots = self
                .snapshots
                .lock()
                .map_err(|_| HostError("file_snapshot_unavailable"))?;
            if self.operation == Operation::Edit {
                let before = snapshots
                    .get(&self.path)
                    .ok_or(HostError("read_required"))?;
                if before != hash {
                    return Err(HostError("file_changed_since_read"));
                }
            } else if self.args["allow_overwrite"] != true
                || snapshots.get(&self.path) != Some(hash)
            {
                return Err(HostError("file_read_required_or_changed"));
            }
        }
        let content = if self.operation == Operation::Edit {
            edit::replace(&previous.as_ref().unwrap().0, &self.args)?
        } else {
            string(&self.args, "content")?.into()
        };
        let parent = self
            .target
            .as_ref()
            .ok_or(HostError("file_parent_unavailable"))?
            .open(run, changed)?;
        #[cfg(feature = "test-fixtures")]
        if self.operation == Operation::Write
            && self.test_root.join(".native-cli-fixture").is_file()
        {
            if std::env::var("PEER_NATIVE_FILE_PARENT_FAULT").as_deref() == Ok("after_parents") {
                std::process::exit(77);
            }
            if std::env::var("PEER_NATIVE_FILE_BARRIER").as_deref() == Ok("parents") {
                std::fs::write(self.test_root.join("file-worker-ready"), "owned")
                    .map_err(|_| HostError("fixture_barrier_unavailable"))?;
                while !self.test_root.join("file-worker-resume").exists() {
                    run.cancel()?;
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
        }
        run.check()?;
        let mut file = parent.open_leaf(previous.is_none())?;
        if previous.is_none() {
            *changed = true;
        }
        if let Some((_, hash)) = &previous {
            if read_handle(&mut file)?.1 != *hash {
                return Err(HostError("file_changed"));
            }
            file.seek(SeekFrom::Start(0))
                .map_err(|_| HostError("file_write_failed"))?;
        }
        run.check()?;
        parent.verify()?;
        // A failed truncate/write can itself be a partial effect. Retain it;
        // neither cleanup nor an automatic retry establishes non-execution.
        *changed = true;
        file.set_len(0)
            .and_then(|_| file.write_all(content.as_bytes()))
            .and_then(|_| file.sync_all())
            .map_err(|_| HostError("execution_outcome_unknown"))?;
        parent.sync()?;
        if previous.is_none() {
            use std::os::unix::fs::MetadataExt;
            let meta = file
                .metadata()
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            let observed = peer_store::file_resource(&self.path, false)
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            if observed.identity != format!("{}:{}", meta.dev(), meta.ino()) {
                return Err(HostError("execution_outcome_unknown"));
            }
            *materialization = Some(observed);
        }
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()));
        self.remember(hash.clone(), true)?;
        Ok(
            json!({"path":scan::display(&self.workspace,&self.path),"bytes":content.len(),"contentHash":hash}),
        )
    }
}
