use crate::{
    StoreError, conversation_write::timestamp, durable_jsonl, files, platform::DirectoryGuard,
    valid_id,
};
use peer_protocol::{
    MAX_ARCHIVED_EPOCHS, WORKING_PLAN_SCHEMA_VERSION, WorkingPlanInput, WorkingPlanSnapshot,
    validate_and_normalize_working_plan,
};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const MAX_WORKING_PLAN_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
pub struct WorkingPlanStore {
    directory: PathBuf,
}

impl WorkingPlanStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            directory: data_home
                .as_ref()
                .join("conversations")
                .join(".working-plans"),
        }
    }

    pub fn read(&self, conversation_id: &str) -> Result<Option<WorkingPlanSnapshot>, StoreError> {
        if !valid_id(conversation_id, false) {
            return Err(StoreError::InvalidInput);
        }
        for directory in [self.conversations(), self.directory.as_path()] {
            match fs::symlink_metadata(directory) {
                Ok(meta) if meta.is_dir() => (),
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                _ => return Err(StoreError::ReadFailed),
            }
        }
        let Some(bytes) = files::read(&self.path(conversation_id), MAX_WORKING_PLAN_BYTES)? else {
            return Ok(None);
        };
        let snapshot: WorkingPlanSnapshot =
            serde_json::from_slice(&bytes).map_err(|_| StoreError::HistoryCorrupt)?;
        if snapshot.schema_version != WORKING_PLAN_SCHEMA_VERSION
            || snapshot.conversation_id != conversation_id
        {
            return Err(StoreError::HistoryCorrupt);
        }
        Ok(Some(snapshot))
    }

    pub fn upsert(
        &self,
        conversation_id: &str,
        epoch: u64,
        input: WorkingPlanInput,
        at: &str,
    ) -> Result<WorkingPlanSnapshot, StoreError> {
        if !valid_id(conversation_id, false) || !timestamp(at) {
            return Err(StoreError::InvalidInput);
        }
        let input =
            validate_and_normalize_working_plan(input).map_err(|_| StoreError::InvalidInput)?;
        let dir = durable_jsonl::directory(self.conversations())?;
        // Reuse the session deletion fence for the storage transaction.
        let guard = DirectoryGuard::lock_nonblocking(&dir)?;
        guard.check_path(self.conversations())?;
        durable_jsonl::directory(&self.directory)?;

        let (revision, archived) = match self.read(conversation_id)? {
            None => (1, vec![]),
            Some(previous) if previous.epoch == epoch => (
                previous
                    .revision
                    .checked_add(1)
                    .ok_or(StoreError::HistoryLimit)?,
                previous.archived,
            ),
            Some(mut previous) if previous.epoch < epoch => {
                archive_steps(&mut previous);
                (1, previous.archived)
            }
            Some(_) => return Err(StoreError::Conflict),
        };
        let snapshot = WorkingPlanSnapshot {
            schema_version: WORKING_PLAN_SCHEMA_VERSION,
            conversation_id: conversation_id.to_owned(),
            epoch,
            revision,
            updated_at: at.to_owned(),
            summary: input.summary,
            invariants: input.invariants,
            steps: input.steps,
            archived,
        };
        self.persist(conversation_id, &snapshot)?;
        Ok(snapshot)
    }

    pub fn archive_for_epoch(
        &self,
        conversation_id: &str,
        new_epoch: u64,
        at: &str,
    ) -> Result<Option<WorkingPlanSnapshot>, StoreError> {
        if !valid_id(conversation_id, false) || !timestamp(at) {
            return Err(StoreError::InvalidInput);
        }
        if self.read(conversation_id)?.is_none() {
            return Ok(None);
        }
        let guard = DirectoryGuard::lock_nonblocking(self.conversations())?;
        guard.check_path(self.conversations())?;
        let Some(mut next) = self.read(conversation_id)? else {
            return Ok(None);
        };
        if next.epoch < new_epoch {
            archive_steps(&mut next);
            next.epoch = new_epoch;
            next.revision = next.revision.saturating_add(1);
            next.updated_at = at.to_owned();
            next.summary = None;
            next.invariants.clear();
            next.steps.clear();
            self.persist(conversation_id, &next)?;
        }
        Ok(Some(next))
    }

    fn conversations(&self) -> &Path {
        self.directory.parent().expect("working plan parent")
    }

    fn path(&self, conversation_id: &str) -> PathBuf {
        self.directory.join(format!("{conversation_id}.json"))
    }

    fn persist(
        &self,
        conversation_id: &str,
        snapshot: &WorkingPlanSnapshot,
    ) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(snapshot).map_err(|_| StoreError::HistoryCorrupt)?;
        if bytes.len() > MAX_WORKING_PLAN_BYTES {
            return Err(StoreError::HistoryLimit);
        }
        durable_jsonl::replace(&self.path(conversation_id), &bytes, None)
    }
}

fn archive_steps(snapshot: &mut WorkingPlanSnapshot) {
    if !snapshot.steps.is_empty() {
        snapshot.archived.push(snapshot.to_archived_entry());
    }
    let excess = snapshot.archived.len().saturating_sub(MAX_ARCHIVED_EPOCHS);
    snapshot.archived.drain(..excess);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ConversationStore, NewConversation, delete_session};
    use peer_protocol::{WorkingPlanStep, WorkingPlanStepStatus};

    const AT: &str = "2026-11-27T00:00:00Z";

    fn input() -> WorkingPlanInput {
        WorkingPlanInput {
            summary: Some("Implement feature".into()),
            invariants: vec!["Preserve permissions".into()],
            steps: vec![WorkingPlanStep {
                title: "Check the boundary".into(),
                status: WorkingPlanStepStatus::InProgress,
                check: None,
                note: None,
            }],
        }
    }

    #[test]
    fn working_plan_store_atomic_upsert_epoch_archive_and_stale_reject() {
        let root = tempfile::tempdir().unwrap();
        let store = WorkingPlanStore::new(root.path());
        let id = "test-plan";
        assert_eq!(store.read(id), Ok(None));
        assert_eq!(store.archive_for_epoch(id, 1, AT), Ok(None));
        let first = store.upsert(id, 0, input(), AT).unwrap();
        assert_eq!(first.revision, 1);
        assert_eq!(store.read(id), Ok(Some(first)));
        let second = store.upsert(id, 0, input(), AT).unwrap();
        assert_eq!(second.revision, 2);
        let third = store.upsert(id, 1, input(), AT).unwrap();
        assert_eq!(third.revision, 1);
        assert_eq!(third.archived, [second.to_archived_entry()]);
        assert_eq!(store.upsert(id, 0, input(), AT), Err(StoreError::Conflict));
        let archived = store.archive_for_epoch(id, 2, AT).unwrap().unwrap();
        assert_eq!(archived.epoch, 2);
        assert_eq!(archived.revision, 2);
        assert!(archived.steps.is_empty());
        assert_eq!(archived.archived[1], third.to_archived_entry());
        assert_eq!(store.archive_for_epoch(id, 2, AT), Ok(Some(archived)));
        for epoch in 2..=(MAX_ARCHIVED_EPOCHS as u64 + 3) {
            store.upsert(id, epoch, input(), AT).unwrap();
        }
        let latest = store.read(id).unwrap().unwrap();
        assert_eq!(latest.archived.len(), MAX_ARCHIVED_EPOCHS);
        assert_eq!(latest.archived.first().unwrap().epoch, 3);
    }

    #[test]
    fn session_delete_removes_working_plan_file() {
        let root = tempfile::tempdir().unwrap();
        let meta = ConversationStore::new(root.path())
            .create(
                &NewConversation {
                    title: "Working plan cascade",
                    workspace_path: None,
                    mode: "chat",
                    created_at: AT,
                },
                None,
            )
            .unwrap();
        let id = meta["id"].as_str().unwrap();
        let store = WorkingPlanStore::new(root.path());
        store.upsert(id, 0, input(), AT).unwrap();
        assert!(store.path(id).is_file());
        delete_session(root.path(), id).unwrap();
        assert_eq!(store.read(id), Ok(None));
    }
}
