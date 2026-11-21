//! Ordered 7-phase workspace startup recovery barrier (`packages/runtime-node/src/project-agent/recovery.mjs`).
//! Persists diagnostics to `<data_home>/project-runtime/<workspaceId>/recovery.json`.

use crate::{ProjectError, atomic_write, is_valid_workspace_id, now_iso};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Mutex,
};

pub const RECOVERY_PHASES: [&str; 7] = [
    "lease", "inputs", "inbox", "queue", "tasks", "watch", "digest",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDiagnostic {
    pub status: String,
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub at: String,
    #[serde(default)]
    pub recovered_sessions: usize,
    #[serde(default)]
    pub watch_signals: usize,
    #[serde(default)]
    pub flushed_digest: bool,
}

#[derive(Debug, Default)]
pub struct RecoveryRunCounts {
    pub recovered_sessions: usize,
    pub watch_signals: usize,
    pub flushed_digest: bool,
}

#[derive(Default)]
struct RecoveryState {
    ready: HashSet<String>,
    epochs: HashMap<String, u64>,
    statuses: HashMap<String, RecoveryDiagnostic>,
}

pub struct ProjectRecoveryBarrier {
    runtime_root: PathBuf,
    state: Mutex<RecoveryState>,
}

impl ProjectRecoveryBarrier {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
            state: Mutex::new(RecoveryState::default()),
        }
    }

    pub fn diagnostic_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self.runtime_root.join(workspace_id).join("recovery.json"))
    }

    fn persist_diagnostic(
        &self,
        workspace_id: &str,
        record: RecoveryDiagnostic,
    ) -> Result<(), ProjectError> {
        if let Ok(mut g) = self.state.lock() {
            g.statuses.insert(workspace_id.to_owned(), record.clone());
        }
        let path = self.diagnostic_file(workspace_id)?;
        let mut body = serde_json::to_string(&record)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&path, body.as_bytes())
    }

    pub fn is_ready(&self, workspace_id: &str, holds_lease: bool) -> bool {
        if !holds_lease {
            return false;
        }
        self.state
            .lock()
            .ok()
            .is_some_and(|g| g.ready.contains(workspace_id))
    }

    pub fn status(&self, workspace_id: &str) -> Option<RecoveryDiagnostic> {
        if let Ok(g) = self.state.lock()
            && let Some(st) = g.statuses.get(workspace_id)
        {
            return Some(st.clone());
        }
        let path = self.diagnostic_file(workspace_id).ok()?;
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }

    pub fn drop_workspace(&self, workspace_id: &str) {
        if let Ok(mut g) = self.state.lock() {
            g.ready.remove(workspace_id);
            let next = g.epochs.get(workspace_id).copied().unwrap_or(0) + 1;
            g.epochs.insert(workspace_id.to_owned(), next);
        }
    }

    pub fn record_failure(&self, workspace_id: &str, phase: &str, error: &str) {
        if let Ok(mut g) = self.state.lock() {
            g.ready.remove(workspace_id);
        }
        let _ = self.persist_diagnostic(
            workspace_id,
            RecoveryDiagnostic {
                status: "failed".to_owned(),
                phase: phase.to_owned(),
                error: Some(error.to_owned()),
                at: now_iso(),
                recovered_sessions: 0,
                watch_signals: 0,
                flushed_digest: false,
            },
        );
    }

    /// Execute the 7-phase workspace recovery barrier in order, checking lease custody before and after each phase.
    pub async fn run_phases<'a, F>(
        &self,
        workspace_id: &str,
        holds_lease: impl Fn(&str) -> bool,
        mut run_phase: F,
    ) -> Result<RecoveryDiagnostic, ProjectError>
    where
        F: FnMut(
            &'static str,
            RecoveryRunCounts,
        )
            -> Pin<Box<dyn Future<Output = Result<RecoveryRunCounts, ProjectError>> + 'a>>,
    {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        if self.is_ready(workspace_id, holds_lease(workspace_id))
            && let Some(existing) = self.status(workspace_id)
        {
            return Ok(existing);
        }
        let epoch = self
            .state
            .lock()
            .ok()
            .map(|mut g| {
                g.ready.remove(workspace_id);
                g.epochs.get(workspace_id).copied().unwrap_or(0)
            })
            .unwrap_or(0);

        let mut counts = RecoveryRunCounts::default();
        for phase in RECOVERY_PHASES {
            if phase != "lease" && !holds_lease(workspace_id) {
                self.record_failure(workspace_id, phase, "lease_unavailable");
                return Err(ProjectError::code("LEASE_REQUIRED"));
            }
            counts = match Box::pin(run_phase(phase, counts)).await {
                Ok(next) => next,
                Err(err) => {
                    self.record_failure(workspace_id, phase, err.code);
                    return Err(err);
                }
            };
            let current_epoch = self
                .state
                .lock()
                .ok()
                .and_then(|g| g.epochs.get(workspace_id).copied())
                .unwrap_or(0);
            if current_epoch != epoch {
                self.record_failure(workspace_id, phase, "recovery_cancelled");
                return Err(ProjectError::code("CANCELLED"));
            }
            if !holds_lease(workspace_id) {
                self.record_failure(workspace_id, phase, "lease_unavailable");
                return Err(ProjectError::code("LEASE_REQUIRED"));
            }
        }

        if let Ok(mut g) = self.state.lock() {
            g.ready.insert(workspace_id.to_owned());
        }
        let diag = RecoveryDiagnostic {
            status: "ready".to_owned(),
            phase: "digest".to_owned(),
            error: None,
            at: now_iso(),
            recovered_sessions: counts.recovered_sessions,
            watch_signals: counts.watch_signals,
            flushed_digest: counts.flushed_digest,
        };
        self.persist_diagnostic(workspace_id, diag.clone())?;
        Ok(diag)
    }
}
