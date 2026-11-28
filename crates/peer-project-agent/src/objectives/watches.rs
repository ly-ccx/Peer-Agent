//! Objective watch runner (`file_hash`, `git_ref`, ephemeral `agent` probe), persistent watch
//! cursors (`watch-state.json`), and `ProjectInbox` signal emission (ADR 82).

use crate::{
    ProjectError, ProjectInbox, atomic_write, format_iso, is_valid_workspace_id, now_iso,
    objectives::{AppendObservationRequest, ObjectiveItem, ObjectiveStore, WatchObservation},
    parse_iso_ms,
};
use peer_runtime::{CancellationToken, model::NativeModel};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub observation: WatchObservation,
    pub emitted_signal: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchCursorState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_scheduled_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_observation_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_execution_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_signal_execution_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_signal_execution_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchStateDoc {
    schema_version: u32,
    cursors: BTreeMap<String, WatchCursorState>,
}

impl Default for WatchStateDoc {
    fn default() -> Self {
        Self {
            schema_version: 1,
            cursors: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchReconcileReport {
    pub workspace_id: String,
    pub watches_checked: usize,
    pub observations_recorded: usize,
    pub signals_emitted: usize,
}

pub fn signal_allowed(objective: &ObjectiveItem, watch: &Value, obs: &WatchObservation) -> bool {
    objective.status == "active"
        && objective.pending_confirmation != Some(true)
        && obs.changed
        && !(watch["kind"] == "event"
            && watch["source"]["type"] == "task_event"
            && obs.value.as_deref() == Some("[]"))
        && (watch["notificationPolicy"].as_str() != Some("failure_only")
            || (obs.succeeded == Some(false) && obs.severity == "urgent"))
}

fn watch_definition_hash(watch: &Value) -> String {
    let serialized = serde_json::to_string(watch).unwrap_or_else(|_| "{}".into());
    format!("{:x}", Sha256::digest(serialized.as_bytes()))
}

fn schedule_interval_ms(watch: &Value, default_poll_ms: i64) -> i64 {
    let sched = &watch["schedule"];
    if let Some(ms) = sched["everyMs"].as_i64().filter(|n| *n > 0) {
        return ms;
    }
    if let Some(secs) = sched["everySeconds"].as_i64().filter(|n| *n > 0) {
        return secs.saturating_mul(1000);
    }
    if let Some(mins) = sched["everyMinutes"].as_i64().filter(|n| *n > 0) {
        return mins.saturating_mul(60_000);
    }
    default_poll_ms.max(1_000)
}

fn unwrap_json_body(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let inner = if let Some(s) = trimmed.find("```") {
        let rest = &trimmed[s + 3..];
        let rest = rest
            .strip_prefix("json")
            .or_else(|| rest.strip_prefix("JSON"))
            .unwrap_or(rest);
        rest.find("```")
            .map(|e| rest[..e].trim())
            .unwrap_or(trimmed)
    } else {
        trimmed
    };
    let start = inner.find('{')?;
    Some(inner[start..].to_owned())
}

struct SignalObservationInput<'a> {
    workspace_id: &'a str,
    objective: &'a ObjectiveItem,
    watch: &'a Value,
    watch_id: &'a str,
    execution_key: &'a str,
    digest: &'a str,
    summary: &'a str,
    severity: &'a str,
    succeeded: Option<bool>,
    value: Option<String>,
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

    fn state_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("objectives")
            .join("watch-state.json"))
    }

    fn read_state_doc(&self, workspace_id: &str) -> Result<WatchStateDoc, ProjectError> {
        let file = self.state_file(workspace_id)?;
        let raw = match fs::read_to_string(&file) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WatchStateDoc::default());
            }
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        Ok(serde_json::from_str::<WatchStateDoc>(&raw).unwrap_or_default())
    }

    fn write_state_doc(&self, workspace_id: &str, doc: &WatchStateDoc) -> Result<(), ProjectError> {
        let file = self.state_file(workspace_id)?;
        let mut body = serde_json::to_string(doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&file, body.as_bytes())
    }

    pub fn read_cursor(
        &self,
        workspace_id: &str,
        objective_id: &str,
        watch_id: &str,
    ) -> WatchCursorState {
        let key = format!("{objective_id}:{watch_id}");
        self.read_state_doc(workspace_id)
            .ok()
            .and_then(|d| d.cursors.get(&key).cloned())
            .unwrap_or_default()
    }

    fn check_active_and_budget(
        &self,
        workspace_id: &str,
        objective: &ObjectiveItem,
    ) -> Result<(), ProjectError> {
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
        Ok(())
    }

    fn record_observation_and_signal(
        &self,
        input: SignalObservationInput<'_>,
    ) -> Result<ProbeOutcome, ProjectError> {
        let ev_ref = Self::evidence_ref(input.workspace_id, input.execution_key);
        let (obs, replayed) = self
            .objectives
            .append_observation(AppendObservationRequest {
                workspace_id: input.workspace_id,
                objective_id: &input.objective.objective_id,
                watch_id: input.watch_id,
                execution_key: input.execution_key,
                digest: input.digest,
                summary: input.summary,
                evidence_refs: vec![ev_ref.clone()],
                severity: input.severity,
                succeeded: input.succeeded,
                value: input.value,
            })?;
        let emitted_signal = !replayed && signal_allowed(input.objective, input.watch, &obs);
        if emitted_signal {
            let event_id = format!(
                "obj-{}-{}",
                &input.objective.objective_id[..input.objective.objective_id.len().min(24)],
                &ev_ref[ev_ref.len().saturating_sub(16)..]
            );
            let event: Value = json!({
                "eventId": event_id,
                "kind": "objective_signal",
                "workspaceId": input.workspace_id,
                "objectiveId": input.objective.objective_id,
                "watchId": input.watch_id,
                "executionKey": input.execution_key,
                "at": obs.observed_at,
                "payload": {
                    "digest": obs.digest,
                    "summary": obs.summary,
                    "severity": obs.severity,
                    "evidenceRefs": obs.evidence_refs,
                }
            });
            let _ = self.inbox.append(input.workspace_id, &[event])?;
        }
        Ok(ProbeOutcome {
            observation: obs,
            emitted_signal,
        })
    }

    /// Run a deterministic watch probe against `workspace_path`, persist the observation,
    /// and emit an `objective_signal` inbox event when allowed by watch policy.
    pub fn run_deterministic_probe(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        objective: &ObjectiveItem,
        watch_id: &str,
        execution_key: &str,
    ) -> Result<ProbeOutcome, ProjectError> {
        self.check_active_and_budget(workspace_id, objective)?;
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

        let severity = if succeeded { "notable" } else { "urgent" };
        self.record_observation_and_signal(SignalObservationInput {
            workspace_id,
            objective,
            watch,
            watch_id,
            execution_key,
            digest: &digest,
            summary: &summary,
            severity,
            succeeded: Some(succeeded),
            value,
        })
    }

    /// Run a read-only zero-tool model semantic watch probe (`objective-probe-turn.mjs`).
    #[allow(clippy::too_many_arguments)]
    pub async fn run_agent_probe(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        objective: &ObjectiveItem,
        watch_id: &str,
        execution_key: &str,
        model: &NativeModel,
        cancel: &CancellationToken,
    ) -> Result<ProbeOutcome, ProjectError> {
        self.check_active_and_budget(workspace_id, objective)?;
        let watch = objective
            .watches
            .iter()
            .find(|w| w["watchId"].as_str() == Some(watch_id))
            .ok_or_else(|| ProjectError::code("WATCH_NOT_FOUND"))?;
        let probe = &watch["probe"];
        if probe["type"].as_str() != Some("agent") {
            return Err(ProjectError::code("PROBE_UNSUPPORTED"));
        }
        let question = probe["question"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProjectError::code("INVALID_PROBE"))?;
        let prompt = format!(
            "You are a read-only objective watch probe. Do not call tools.\n\
             Objective: {} — {}\nWorkspace: {}\nQuestion: {question}\n\
             Respond with ONE JSON object: {{\"digest\":\"...\",\"summary\":\"...\",\"severity\":\"info|notable|urgent\",\"succeeded\":true|false,\"value\":\"...\"}}",
            objective.title,
            objective.outcome,
            workspace_path.display()
        );
        let history = json!({
            "messages": [{
                "id": format!("probe-{}", uuid::Uuid::new_v4()),
                "role": "user",
                "kind": "user_input",
                "content": prompt,
            }]
        });
        let turn = Box::pin(model.turn("", &history, &json!([]), cancel))
            .await
            .map_err(|e| ProjectError::new("PROBE_FAILED", e.code))?;
        let raw = turn.content.trim();
        let parsed = unwrap_json_body(raw).and_then(|s| serde_json::from_str::<Value>(&s).ok());
        let summary = parsed
            .as_ref()
            .and_then(|v| v["summary"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(raw)
            .chars()
            .take(500)
            .collect::<String>();
        let digest = parsed
            .as_ref()
            .and_then(|v| v["digest"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{:x}", Sha256::digest(summary.as_bytes())));
        let severity = parsed
            .as_ref()
            .and_then(|v| v["severity"].as_str())
            .filter(|s| matches!(*s, "info" | "notable" | "urgent"))
            .unwrap_or("info")
            .to_owned();
        let succeeded = parsed.as_ref().and_then(|v| v["succeeded"].as_bool());
        let value = parsed
            .as_ref()
            .and_then(|v| v["value"].as_str())
            .map(str::to_owned);

        self.record_observation_and_signal(SignalObservationInput {
            workspace_id,
            objective,
            watch,
            watch_id,
            execution_key,
            digest: &digest,
            summary: &summary,
            severity: &severity,
            succeeded,
            value,
        })
    }

    /// Reconcile all active objectives' watches for `workspace_id`, persisting updated cursors
    /// into `watch-state.json` and emitting `objective_signal` events to `ProjectInbox`.
    pub async fn reconcile_workspace(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        at_iso: &str,
        default_poll_ms: i64,
        model_opt: Option<&NativeModel>,
        cancel: &CancellationToken,
    ) -> Result<WatchReconcileReport, ProjectError> {
        let now_ms = parse_iso_ms(at_iso).unwrap_or(0);
        let mut doc = self.read_state_doc(workspace_id)?;
        let items = self.objectives.list(workspace_id)?;
        let mut report = WatchReconcileReport {
            workspace_id: workspace_id.to_owned(),
            ..Default::default()
        };

        for obj in items {
            if obj.status != "active" || obj.pending_confirmation == Some(true) {
                continue;
            }
            for watch in &obj.watches {
                if cancel.is_cancelled() {
                    break;
                }
                let Some(watch_id) = watch["watchId"].as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                report.watches_checked += 1;
                let key = format!("{}:{watch_id}", obj.objective_id);
                let def_hash = watch_definition_hash(watch);
                let cursor = doc.cursors.entry(key).or_default();
                if cursor.definition_hash.as_deref() != Some(def_hash.as_str()) {
                    *cursor = WatchCursorState {
                        definition_hash: Some(def_hash.clone()),
                        ..Default::default()
                    };
                }

                let interval_ms = schedule_interval_ms(watch, default_poll_ms);
                let last_ms = cursor.last_scheduled_at.as_deref().and_then(parse_iso_ms);
                let due = last_ms.is_none_or(|prev| now_ms.saturating_sub(prev) >= interval_ms);
                if !due {
                    continue;
                }

                let next_ms = now_ms.saturating_add(interval_ms);
                cursor.next_run_at = time::OffsetDateTime::from_unix_timestamp_nanos(
                    i128::from(next_ms) * 1_000_000,
                )
                .ok()
                .and_then(format_iso);

                let exec_key = format!(
                    "objective-watch:{}:{watch_id}:{}:{}",
                    obj.objective_id,
                    &def_hash[..def_hash.len().min(12)],
                    at_iso
                );
                let probe_type = watch["probe"]["type"].as_str().unwrap_or("");
                let outcome_res = match probe_type {
                    "deterministic" => self.run_deterministic_probe(
                        workspace_id,
                        workspace_path,
                        &obj,
                        watch_id,
                        &exec_key,
                    ),
                    "agent" => {
                        if let Some(model) = model_opt {
                            Box::pin(self.run_agent_probe(
                                workspace_id,
                                workspace_path,
                                &obj,
                                watch_id,
                                &exec_key,
                                model,
                                cancel,
                            ))
                            .await
                        } else {
                            continue;
                        }
                    }
                    _ => Err(ProjectError::code("PROBE_UNSUPPORTED")),
                };

                match outcome_res {
                    Ok(out) => {
                        report.observations_recorded += 1;
                        if out.emitted_signal {
                            report.signals_emitted += 1;
                            cursor.last_signal_execution_key = Some(exec_key);
                        }
                        cursor.last_scheduled_at = Some(at_iso.to_owned());
                        cursor.last_observation_at = Some(out.observation.observed_at);
                        cursor.last_digest = Some(out.observation.digest);
                        cursor.unavailable_reason = None;
                    }
                    Err(err) => {
                        cursor.unavailable_reason = Some(err.code.to_owned());
                    }
                }
            }
        }

        self.write_state_doc(workspace_id, &doc)?;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::objectives::{CreateObjectiveRequest, ObjectiveBudget};
    use tempfile::tempdir;

    #[tokio::test]
    async fn watch_reconcile_persists_cursors_gates_intervals_and_resets_on_config_change() {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        fs::write(ws.path().join("Cargo.toml"), "[package]\nname = \"w\"\n").unwrap();

        let obj_store = ObjectiveStore::new(home.path());
        let (mut obj, _) = obj_store
            .create(&CreateObjectiveRequest {
                workspace_id: "ws-w",
                project_agent_conversation_id: "conv-w",
                origin_message_id: "input-1",
                title: "Watch Cargo.toml",
                outcome: "Detect manifest changes",
                autonomy: "propose",
                created_by: "user_request",
                watches: vec![json!({
                    "watchId": "w-file",
                    "kind": "schedule",
                    "schedule": { "everySeconds": 60 },
                    "probe": { "type": "deterministic", "check": "file_hash", "spec": { "path": "Cargo.toml" } }
                })],
                milestones: vec![],
                success_signals: vec![],
                budget: Some(ObjectiveBudget::default()),
                deadline: None,
                request_id: Some("req-w-1"),
            })
            .unwrap();

        let host = WatchHost::new(home.path());
        let cancel = CancellationToken::new();
        let r1 = host
            .reconcile_workspace(
                "ws-w",
                ws.path(),
                "2026-11-20T10:00:00.000Z",
                60_000,
                None,
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(r1.observations_recorded, 1);
        assert_eq!(r1.signals_emitted, 1);

        // Within 60s interval -> gated
        let r2 = host
            .reconcile_workspace(
                "ws-w",
                ws.path(),
                "2026-11-20T10:00:30.000Z",
                60_000,
                None,
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(r2.observations_recorded, 0);

        // Changing watch definition resets cursor hash cleanly
        obj.watches[0]["notificationPolicy"] = json!("failure_only");
        let updated = obj_store
            .update(
                "ws-w",
                &obj.objective_id,
                &crate::objectives::UpdateObjectiveRequest {
                    watches: Some(obj.watches.clone()),
                    expected_version: Some(obj.version),
                    ..Default::default()
                },
            )
            .unwrap();
        let _ = updated;

        let r3 = host
            .reconcile_workspace(
                "ws-w",
                ws.path(),
                "2026-11-20T10:00:40.000Z",
                60_000,
                None,
                &cancel,
            )
            .await
            .unwrap();
        assert_eq!(r3.observations_recorded, 1);
        // failure_only suppresses info/notable success signal
        assert_eq!(r3.signals_emitted, 0);
    }
}
