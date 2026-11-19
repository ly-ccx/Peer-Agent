//! Deterministic objective watch probes (`file_hash`, `git_ref`) and signal emission
//! into `ProjectInbox` with daily probe budget enforcement (ADR 82).

use crate::{
    ProjectError, ProjectInbox, now_iso,
    objectives::{AppendObservationRequest, ObjectiveItem, ObjectiveStore, WatchObservation},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub observation: WatchObservation,
    pub emitted_signal: bool,
}

pub struct WatchHost {
    data_home: PathBuf,
    objectives: ObjectiveStore,
    inbox: ProjectInbox,
}

impl WatchHost {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            objectives: ObjectiveStore::new(&home),
            inbox: ProjectInbox::new(&home),
            data_home: home,
        }
    }

    pub fn evidence_ref(workspace_id: &str, execution_key: &str) -> String {
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("{workspace_id}:{execution_key}").as_bytes())
        );
        format!("watch:{}:{}", workspace_id, &digest[..16])
    }

    /// Run a deterministic watch probe against `workspace_path`, persist the observation,
    /// and emit an `objective_signal` inbox event when the observation changed.
    pub fn run_deterministic_probe(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        objective: &ObjectiveItem,
        watch_id: &str,
        execution_key: &str,
    ) -> Result<ProbeOutcome, ProjectError> {
        if objective.status != "active" {
            return Err(ProjectError::code("OBJECTIVE_NOT_ACTIVE"));
        }
        let today = now_iso();
        let day = &today[..10];
        let prior_obs = self
            .objectives
            .observations(workspace_id, &objective.objective_id)?;
        let runs_today = prior_obs
            .iter()
            .filter(|o| o.observed_at.starts_with(day))
            .count();
        if runs_today >= objective.budget.max_probe_runs_per_day as usize {
            return Err(ProjectError::code("PROBE_BUDGET_EXHAUSTED"));
        }

        let watch = objective
            .watches
            .iter()
            .find(|w| w["watchId"].as_str() == Some(watch_id))
            .ok_or_else(|| ProjectError::code("WATCH_NOT_FOUND"))?;
        let probe = &watch["probe"];
        if probe["type"].as_str() != Some("deterministic") {
            return Err(ProjectError::code("PROBE_UNSUPPORTED"));
        }
        let (digest, summary, succeeded, value) = match probe["check"].as_str() {
            Some("file_hash") => {
                let rel = probe["spec"]["path"]
                    .as_str()
                    .ok_or_else(|| ProjectError::code("INVALID_PROBE"))?;
                let target = workspace_path.join(rel);
                match fs::read(&target) {
                    Ok(bytes) => {
                        let hash = format!("{:x}", Sha256::digest(&bytes));
                        (
                            hash.clone(),
                            format!("file_hash({rel}) = {} ({} bytes)", &hash[..12], bytes.len()),
                            true,
                            Some(hash),
                        )
                    }
                    Err(_) => (
                        "missing".to_owned(),
                        format!("file_hash({rel}) = missing"),
                        false,
                        None,
                    ),
                }
            }
            Some("git_ref") => {
                let git_ref = probe["spec"]["ref"]
                    .as_str()
                    .ok_or_else(|| ProjectError::code("INVALID_PROBE"))?;
                let out = Command::new("git")
                    .args(["rev-parse", "--verify", git_ref])
                    .current_dir(workspace_path)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .output()
                    .map_err(|e| ProjectError::new("GIT_ERROR", e.to_string()))?;
                if out.status.success() {
                    let sha = String::from_utf8_lossy(&out.stdout).trim().to_owned();
                    (
                        sha.clone(),
                        format!("git_ref({git_ref}) = {}", &sha[..sha.len().min(12)]),
                        true,
                        Some(sha),
                    )
                } else {
                    (
                        "missing".to_owned(),
                        format!("git_ref({git_ref}) = unresolved"),
                        false,
                        None,
                    )
                }
            }
            _ => return Err(ProjectError::code("PROBE_UNSUPPORTED")),
        };

        let ev_ref = Self::evidence_ref(workspace_id, execution_key);
        let severity = if succeeded { "notable" } else { "urgent" };
        let (obs, replayed) = self
            .objectives
            .append_observation(AppendObservationRequest {
                workspace_id,
                objective_id: &objective.objective_id,
                watch_id,
                execution_key,
                digest: &digest,
                summary: &summary,
                evidence_refs: vec![ev_ref.clone()],
                severity,
                succeeded: Some(succeeded),
                value,
            })?;
        let emitted_signal = !replayed && obs.changed;
        if emitted_signal {
            let event_id = format!(
                "obj-{}-{}",
                &objective.objective_id[..objective.objective_id.len().min(24)],
                &ev_ref[ev_ref.len().saturating_sub(16)..]
            );
            let event: Value = json!({
                "eventId": event_id,
                "kind": "objective_signal",
                "workspaceId": workspace_id,
                "objectiveId": objective.objective_id,
                "watchId": watch_id,
                "executionKey": execution_key,
                "at": obs.observed_at,
                "payload": {
                    "digest": obs.digest,
                    "summary": obs.summary,
                    "severity": obs.severity,
                    "evidenceRefs": obs.evidence_refs,
                }
            });
            let _ = self.inbox.append(workspace_id, &[event])?;
        }
        // Keep data_home field live for future evidence storage.
        let _ = &self.data_home;
        Ok(ProbeOutcome {
            observation: obs,
            emitted_signal,
        })
    }
}
