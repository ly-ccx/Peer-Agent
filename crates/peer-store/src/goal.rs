//! Canonical Goal execution facts for the native CLI. UI bodies/checkpoints stay
//! in their original files; this is a fresh source projection, never live proof.
use crate::{StoreError, files, valid_id};
use peer_protocol::{
    GoalFactProjector, JsonLimits, JsonSelection as S, ProjectionError, ProjectionLimits,
    project_json_selected_reader,
};
use serde_json::Value;
use std::{
    fmt,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
};
static TASK: S<'static> = S::Object(&[("status", S::Full), ("subtasks", S::Each(&TASK))]);
const RUNNER: S<'static> = S::Object(&[
    ("enabled", S::Full),
    ("status", S::Full),
    ("intent", S::Full),
    ("phase", S::Full),
    ("currentTaskId", S::Full),
    ("runId", S::Full),
    ("updatedAt", S::Full),
    ("interruption", S::Full),
    ("turnCount", S::Full),
    ("roundCount", S::Full),
    ("toolCallCount", S::Full),
    ("explorerCount", S::Full),
    ("contextCheckpoint", S::Object(&[])),
    ("verificationContinuation", S::Full),
]);
static PLAN: S<'static> = S::Object(&[
    ("targetWorkspacePath", S::Full),
    ("originWorkspacePath", S::Full),
    (
        "deliveryBinding",
        S::Object(&[
            ("executionIsolation", S::Full),
            ("worktreePath", S::Full),
            ("targetWorkspacePath", S::Full),
        ]),
    ),
    ("planId", S::Full),
    ("conversationId", S::Full),
    ("status", S::Full),
    ("version", S::Full),
    ("createdAt", S::Full),
    ("updatedAt", S::Full),
    ("approval", S::Object(&[("decision", S::Full)])),
    ("tasks", S::Each(&TASK)),
    ("delegationOrigin", S::Full),
    ("runner", RUNNER),
]);
static PROGRESS: S<'static> = S::Object(&[
    ("planId", S::Full),
    ("status", S::Full),
    ("updatedAt", S::Full),
    ("runner", RUNNER),
]);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalError {
    Store(StoreError),
    Invalid,
    Limit,
    Changed,
    Projection(&'static str),
}
impl GoalError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Store(e) => e.code(),
            Self::Invalid => "GOAL_SOURCE_INVALID",
            Self::Limit => "GOAL_SOURCE_LIMIT",
            Self::Changed => "GOAL_SOURCE_CHANGED",
            Self::Projection(code) => code,
        }
    }
}
impl fmt::Display for GoalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for GoalError {}
impl From<StoreError> for GoalError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::HistoryLimit => Self::Limit,
            StoreError::VersionChanged => Self::Changed,
            _ => Self::Store(e),
        }
    }
}
#[derive(Debug)]
pub struct GoalSnapshot {
    pub facts: Value,
    pub source_revision: String,
    pub source_bytes: u64,
}
pub struct GoalSelection {
    pub snapshot: Option<GoalSnapshot>,
    pub source_revision: String,
}
pub struct GoalStore {
    directory: PathBuf,
}
fn read(
    path: &Path,
    spec: &S<'_>,
    max: u64,
    cancel: Option<&AtomicBool>,
) -> Result<Option<(Value, u64)>, GoalError> {
    let Some((file, before)) = files::open(path, max)? else {
        return Ok(None);
    };
    let result = project_json_selected_reader(
        &file,
        spec,
        ProjectionLimits {
            source_bytes: max,
            selected: JsonLimits {
                bytes: 4 * 1024 * 1024,
                nodes: 32_768,
                depth: 64,
                string_bytes: 4 * 1024 * 1024,
            },
            key_bytes: 512,
        },
        cancel,
    )
    .map_err(|e| match e {
        ProjectionError::LimitExceeded => GoalError::Limit,
        ProjectionError::InvalidJson => GoalError::Invalid,
        ProjectionError::Cancelled => GoalError::Store(StoreError::Cancelled),
        ProjectionError::ReadFailed => GoalError::Store(StoreError::ReadFailed),
    })?;
    if files::identity(path)?.as_ref() != Some(&before) {
        return Err(GoalError::Changed);
    }
    Ok(Some((result.value, result.source_bytes)))
}
impl GoalStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            directory: data_home.as_ref().join("goal-plans"),
        }
    }
    /// The existing index selects candidates; every candidate is hydrated from
    /// canonical plan + runner progress. A broken/missing index cannot establish
    /// that an ancestor does not exist and thereby expand permission ancestry.
    pub fn active_by_conversation(
        &self,
        conversation: &str,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
    ) -> Result<GoalSelection, GoalError> {
        if !valid_id(conversation, false) {
            return Err(GoalError::Invalid);
        }
        let path = self.directory.join("index.jsonl");
        let before = files::identity(&path)?.ok_or(StoreError::NotFound)?;
        let rows = crate::durable_jsonl::read(&path, cancel)?;
        let mut ids = std::collections::HashSet::new();
        let mut sources = Vec::new();
        let mut selected: Option<GoalSnapshot> = None;
        for row in rows {
            let id = row["planId"]
                .as_str()
                .filter(|id| valid_id(id, false))
                .ok_or(GoalError::Invalid)?;
            if !ids.insert(id.to_owned()) {
                return Err(GoalError::Invalid);
            }
            if row["conversationId"] != conversation {
                continue;
            }
            let snapshot = self.read(id, projector, cancel)?;
            if snapshot.facts["conversationId"] != conversation {
                return Err(GoalError::Invalid);
            }
            sources.push((id.to_owned(), snapshot.source_revision.clone()));
            if snapshot.facts["active"] != true {
                continue;
            }
            let updated = snapshot.facts["updatedAt"]
                .as_str()
                .ok_or(GoalError::Invalid)?;
            // Match the canonical index's descending ISO string ordering. Other
            // historical date encodings require an explicit compatible adapter.
            if !updated.is_ascii() || !updated.ends_with('Z') || updated.len() < 20 {
                return Err(GoalError::Projection("GOAL_TIMESTAMP_UNSUPPORTED"));
            }
            if selected
                .as_ref()
                .is_none_or(|old| updated > old.facts["updatedAt"].as_str().unwrap_or(""))
            {
                selected = Some(snapshot);
            }
        }
        if files::identity(&path)?.as_ref() != Some(&before) {
            return Err(GoalError::Changed);
        }
        // Recheck all candidate source pairs, not just the winning plan.
        for (id, revision) in &sources {
            if self.revision(id)? != *revision {
                return Err(GoalError::Changed);
            }
        }
        crate::durable_jsonl::check_cancel(cancel)?;
        let bindings = serde_json::json!([files::fingerprint(&[Some(before)]), sources]);
        let source_revision =
            peer_protocol::javascript_json_digest(&bindings).map_err(|_| GoalError::Limit)?;
        Ok(GoalSelection {
            snapshot: selected,
            source_revision,
        })
    }
    pub fn revision(&self, id: &str) -> Result<String, GoalError> {
        if !valid_id(id, false) {
            return Err(GoalError::Invalid);
        }
        Ok(files::fingerprint(&[
            files::identity(&self.directory.join(format!("{id}.json")))?,
            files::identity(
                &self
                    .directory
                    .join("runner-progress")
                    .join(format!("{id}.json")),
            )?,
        ]))
    }
    pub fn read(
        &self,
        id: &str,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
    ) -> Result<GoalSnapshot, GoalError> {
        crate::durable_jsonl::check_cancel(cancel)?;
        if !valid_id(id, false) {
            return Err(GoalError::Invalid);
        }
        let paths = [
            self.directory.join(format!("{id}.json")),
            self.directory
                .join("runner-progress")
                .join(format!("{id}.json")),
        ];
        let before: Vec<_> = paths
            .iter()
            .map(|p| files::identity(p))
            .collect::<Result<_, _>>()?;
        let (plan, bytes) =
            read(&paths[0], &PLAN, 1024 * 1024 * 1024, cancel)?.ok_or(StoreError::NotFound)?;
        if plan["planId"] != id {
            return Err(GoalError::Invalid);
        }
        let progress = read(&paths[1], &PROGRESS, 4 * 1024 * 1024, cancel)?;
        if progress
            .as_ref()
            .is_some_and(|(p, _)| p["planId"] != id || !p["runner"].is_object())
        {
            return Err(GoalError::Invalid);
        }
        let facts = projector
            .execution_facts(&plan, progress.as_ref().map(|p| &p.0))
            .map_err(GoalError::Projection)?;
        let after: Vec<_> = paths
            .iter()
            .map(|p| files::identity(p))
            .collect::<Result<_, _>>()?;
        if before != after {
            return Err(GoalError::Changed);
        }
        crate::durable_jsonl::check_cancel(cancel)?;
        Ok(GoalSnapshot {
            facts,
            source_revision: files::fingerprint(&before),
            source_bytes: bytes + progress.map_or(0, |(_, n)| n),
        })
    }
}
