//! Raw, read-only Goal field snapshots. These deliberately do not implement
//! normalizePlan, runner-progress merging, execution admission or recovery.
use crate::{StoreError, files, valid_id};
use peer_protocol::{JsonLimits, ProjectionError, ProjectionLimits, project_json_reader};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub struct GoalSourceStore {
    directory: PathBuf,
}
#[derive(Debug)]
pub struct GoalSourceSnapshot {
    pub raw_plan: Value,
    pub raw_runner_progress: Option<Value>,
    pub source_revision: String,
    pub requires_runtime_check: bool,
    pub source_bytes: u64,
}
fn error(error: StoreError) -> StoreError {
    match error {
        StoreError::HistoryLimit => StoreError::GoalLimit,
        StoreError::VersionChanged => StoreError::GoalChanged,
        other => other,
    }
}
fn projection(
    path: &Path,
    fields: &[&str],
    max: u64,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<(Value, u64)>, StoreError> {
    let Some((file, before)) = files::open(path, max).map_err(error)? else {
        return Ok(None);
    };
    let output = project_json_reader(
        &file,
        fields,
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
        cancelled,
    )
    .map_err(|e| match e {
        ProjectionError::LimitExceeded => StoreError::GoalLimit,
        ProjectionError::InvalidJson => StoreError::GoalCorrupt,
        ProjectionError::Cancelled => StoreError::Cancelled,
        ProjectionError::ReadFailed => StoreError::ReadFailed,
    })?;
    if files::identity(path)?.as_ref() != Some(&before) {
        return Err(StoreError::GoalChanged);
    }
    Ok(Some((output.value, output.source_bytes)))
}
impl GoalSourceStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            directory: data_home.as_ref().join("goal-plans"),
        }
    }
    /// max_source_bytes is a scan budget, not permission to execute this Goal.
    pub fn read_raw_fields(
        &self,
        plan_id: &str,
        max_source_bytes: u64,
        cancelled: Option<&AtomicBool>,
    ) -> Result<GoalSourceSnapshot, StoreError> {
        if !valid_id(plan_id, false)
            || max_source_bytes == 0
            || max_source_bytes > 1024 * 1024 * 1024
        {
            return Err(StoreError::InvalidInput);
        }
        if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(StoreError::Cancelled);
        }
        let paths = [
            self.directory.join(format!("{plan_id}.json")),
            self.directory
                .join("runner-progress")
                .join(format!("{plan_id}.json")),
        ];
        let before: Vec<_> = paths
            .iter()
            .map(|p| files::identity(p))
            .collect::<Result<_, _>>()?;
        let Some((raw_plan, source_bytes)) = projection(
            &paths[0],
            &[
                "planId",
                "conversationId",
                "status",
                "version",
                "createdAt",
                "updatedAt",
                "delegationOrigin",
            ],
            max_source_bytes,
            cancelled,
        )?
        else {
            return Err(StoreError::NotFound);
        };
        if raw_plan["planId"].as_str() != Some(plan_id) {
            return Err(StoreError::GoalCorrupt);
        }
        let progress = projection(
            &paths[1],
            &["planId", "status", "runner", "updatedAt"],
            4 * 1024 * 1024,
            cancelled,
        )?;
        if progress
            .as_ref()
            .is_some_and(|(value, _)| value["planId"].as_str() != Some(plan_id))
        {
            return Err(StoreError::GoalCorrupt);
        }
        let after: Vec<_> = paths
            .iter()
            .map(|p| files::identity(p))
            .collect::<Result<_, _>>()?;
        if before != after {
            return Err(StoreError::GoalChanged);
        }
        let (raw_runner_progress, progress_bytes) = match progress {
            Some((value, count)) => (Some(value), count),
            None => (None, 0),
        };
        Ok(GoalSourceSnapshot {
            raw_plan,
            raw_runner_progress,
            source_revision: files::fingerprint(&before),
            requires_runtime_check: true,
            source_bytes: source_bytes + progress_bytes,
        })
    }
}
