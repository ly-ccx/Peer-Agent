//! Project objectives, observations, and device-local action reservations.
//!
//! Matches `packages/runtime-node/src/project-agent/objective-store.mjs` and
//! `objective-actions.mjs` (ADR 82).

pub mod watches;

use crate::{ProjectError, atomic_write, is_valid_workspace_id, now_iso, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub use watches::{ProbeOutcome, WatchCursorState, WatchHost, WatchReconcileReport};

pub fn objective_action_card_id(action_id: &str) -> String {
    format!("card:question:objective:{action_id}")
}

const MAX_AUTO_SESSIONS_PER_DAY: u32 = 3;
const MAX_PROBE_RUNS_PER_DAY: u32 = 1440;
const PROPOSAL_TTL_MS: i64 = 7 * 86_400_000;
const MAX_PENDING_PROPOSALS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveBudget {
    pub max_auto_sessions_per_day: u32,
    pub max_probe_runs_per_day: u32,
}

impl Default for ObjectiveBudget {
    fn default() -> Self {
        Self {
            max_auto_sessions_per_day: 3,
            max_probe_runs_per_day: 60,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveMilestone {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub session_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveItem {
    pub objective_id: String,
    pub workspace_id: String,
    pub project_agent_conversation_id: String,
    pub origin_message_id: String,
    pub title: String,
    pub outcome: String,
    pub autonomy: String,
    pub created_by: String,
    #[serde(default)]
    pub watches: Vec<Value>,
    #[serde(default)]
    pub milestones: Vec<ObjectiveMilestone>,
    #[serde(default)]
    pub success_signals: Vec<Value>,
    #[serde(default)]
    pub budget: ObjectiveBudget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_accept: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_accept_approved_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_confirmation: Option<bool>,
    pub created_at: String,
    pub updated_at: String,
    pub version: u64,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectivesDocument {
    schema_version: u32,
    items: Vec<ObjectiveItem>,
    #[serde(default)]
    requests: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    commands: BTreeMap<String, Value>,
}

impl ObjectivesDocument {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            items: Vec::new(),
            requests: BTreeMap::new(),
            commands: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchObservation {
    pub objective_id: String,
    pub watch_id: String,
    pub execution_key: String,
    pub digest: String,
    pub summary: String,
    pub observed_at: String,
    pub evidence_refs: Vec<String>,
    pub severity: String,
    pub changed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub succeeded: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

pub struct CreateObjectiveRequest<'a> {
    pub workspace_id: &'a str,
    pub project_agent_conversation_id: &'a str,
    pub origin_message_id: &'a str,
    pub title: &'a str,
    pub outcome: &'a str,
    pub autonomy: &'a str,
    pub created_by: &'a str,
    pub watches: Vec<Value>,
    pub milestones: Vec<ObjectiveMilestone>,
    pub success_signals: Vec<Value>,
    pub budget: Option<ObjectiveBudget>,
    pub deadline: Option<&'a str>,
    pub request_id: Option<&'a str>,
}

#[derive(Debug, Default)]
pub struct UpdateObjectiveRequest<'a> {
    pub title: Option<&'a str>,
    pub outcome: Option<&'a str>,
    pub autonomy: Option<&'a str>,
    pub watches: Option<Vec<Value>>,
    pub milestones: Option<Vec<ObjectiveMilestone>>,
    pub success_signals: Option<Vec<Value>>,
    pub budget: Option<ObjectiveBudget>,
    pub deadline: Option<Option<&'a str>>,
    pub auto_accept: Option<bool>,
    pub expected_version: Option<u64>,
}

fn valid_obj_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 200
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn safe_relative_path(p: &str) -> bool {
    let t = p.trim();
    !t.is_empty()
        && t.len() <= 500
        && !t.starts_with('/')
        && !t.starts_with('-')
        && !t.contains('\\')
        && !t.split('/').any(|seg| seg == "..")
}

fn validate_probe(probe: &Value) -> bool {
    match probe["type"].as_str() {
        Some("agent") => probe["question"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 1000),
        Some("deterministic") => {
            let Some(spec) = probe["spec"].as_object() else {
                return false;
            };
            match probe["check"].as_str() {
                Some("file_hash") => spec
                    .get("path")
                    .and_then(Value::as_str)
                    .is_some_and(safe_relative_path),
                Some("git_ref") => spec
                    .get("ref")
                    .and_then(Value::as_str)
                    .is_some_and(|r| !r.trim().is_empty() && r.len() <= 200 && !r.starts_with('-')),
                Some("command") => {
                    spec.get("command").and_then(Value::as_str) == Some("gh_run_list")
                }
                _ => false,
            }
        }
        _ => false,
    }
}

fn validate_watches(watches: &[Value]) -> Result<(), ProjectError> {
    if watches.len() > 16 {
        return Err(ProjectError::code("INVALID_OBJECTIVE"));
    }
    let mut ids = HashSet::new();
    for watch in watches {
        let Some(wid) = watch["watchId"].as_str().filter(|s| valid_obj_id(s)) else {
            return Err(ProjectError::code("INVALID_WATCH"));
        };
        if !ids.insert(wid) {
            return Err(ProjectError::code("INVALID_WATCH"));
        }
        match watch["kind"].as_str() {
            Some("schedule") => {
                if !watch.get("probe").is_some_and(validate_probe) {
                    return Err(ProjectError::code("INVALID_PROBE"));
                }
            }
            Some("event") => {
                let source = &watch["source"];
                match source["type"].as_str() {
                    Some("task_event") => {
                        if !matches!(
                            source["filter"].as_str(),
                            Some("failed" | "ended" | "verified")
                        ) {
                            return Err(ProjectError::code("INVALID_WATCH"));
                        }
                    }
                    Some("git") => {
                        if !source["ref"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
                            || !matches!(source["on"].as_str(), Some("new_commits" | "new_tag"))
                        {
                            return Err(ProjectError::code("INVALID_WATCH"));
                        }
                    }
                    Some("files") => {
                        let Some(paths) = source["paths"].as_array() else {
                            return Err(ProjectError::code("INVALID_WATCH"));
                        };
                        if paths.is_empty()
                            || paths.len() > 16
                            || paths
                                .iter()
                                .any(|p| !p.as_str().is_some_and(safe_relative_path))
                        {
                            return Err(ProjectError::code("INVALID_WATCH"));
                        }
                    }
                    _ => return Err(ProjectError::code("INVALID_WATCH")),
                }
                if let Some(probe) = watch.get("probe")
                    && !probe.is_null()
                    && !validate_probe(probe)
                {
                    return Err(ProjectError::code("INVALID_PROBE"));
                }
            }
            _ => return Err(ProjectError::code("INVALID_WATCH")),
        }
    }
    Ok(())
}

pub struct AppendObservationRequest<'a> {
    pub workspace_id: &'a str,
    pub objective_id: &'a str,
    pub watch_id: &'a str,
    pub execution_key: &'a str,
    pub digest: &'a str,
    pub summary: &'a str,
    pub evidence_refs: Vec<String>,
    pub severity: &'a str,
    pub succeeded: Option<bool>,
    pub value: Option<String>,
}

pub struct ObjectiveStore {
    projects_dir: PathBuf,
}

impl ObjectiveStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            projects_dir: data_home.as_ref().join("projects"),
        }
    }

    fn dir(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self.projects_dir.join(workspace_id).join("objectives"))
    }

    fn read_doc(&self, workspace_id: &str) -> Result<ObjectivesDocument, ProjectError> {
        let path = self.dir(workspace_id)?.join("objectives.json");
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ObjectivesDocument::empty());
            }
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        let doc: ObjectivesDocument =
            serde_json::from_str(&raw).map_err(|_| ProjectError::code("CORRUPT_OBJECTIVES"))?;
        if doc.schema_version != 1 {
            return Err(ProjectError::code("CORRUPT_OBJECTIVES"));
        }
        Ok(doc)
    }

    fn save_doc(&self, workspace_id: &str, doc: &ObjectivesDocument) -> Result<(), ProjectError> {
        let path = self.dir(workspace_id)?.join("objectives.json");
        let mut body = serde_json::to_string(doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&path, body.as_bytes())
    }

    pub fn list(&self, workspace_id: &str) -> Result<Vec<ObjectiveItem>, ProjectError> {
        Ok(self.read_doc(workspace_id)?.items)
    }

    pub fn get(
        &self,
        workspace_id: &str,
        objective_id: &str,
    ) -> Result<Option<ObjectiveItem>, ProjectError> {
        Ok(self
            .list(workspace_id)?
            .into_iter()
            .find(|i| i.objective_id == objective_id))
    }

    pub fn create(
        &self,
        req: &CreateObjectiveRequest<'_>,
    ) -> Result<(ObjectiveItem, bool), ProjectError> {
        if !is_valid_workspace_id(req.workspace_id)
            || req.project_agent_conversation_id.trim().is_empty()
            || req.origin_message_id.trim().is_empty()
            || req.title.trim().is_empty()
            || req.title.chars().count() > 120
            || req.outcome.trim().is_empty()
            || req.outcome.chars().count() > 2000
            || !matches!(req.autonomy, "report_only" | "propose" | "act")
            || !matches!(req.created_by, "user_request" | "agent_proposal")
        {
            return Err(ProjectError::code("INVALID_OBJECTIVE"));
        }
        let budget = req.budget.clone().unwrap_or_default();
        if budget.max_auto_sessions_per_day > MAX_AUTO_SESSIONS_PER_DAY
            || budget.max_probe_runs_per_day == 0
            || budget.max_probe_runs_per_day > MAX_PROBE_RUNS_PER_DAY
        {
            return Err(ProjectError::code("INVALID_BUDGET"));
        }
        if let Some(dl) = req.deadline
            && parse_iso_ms(dl).is_none()
        {
            return Err(ProjectError::code("INVALID_DEADLINE"));
        }
        validate_watches(&req.watches)?;
        let mut doc = self.read_doc(req.workspace_id)?;
        if let Some(rid) = req.request_id
            && let Some(existing_id) = doc.requests.get(rid)
            && let Some(found) = doc.items.iter().find(|i| &i.objective_id == existing_id)
        {
            return Ok((found.clone(), true));
        }
        let at = now_iso();
        let status = if req.created_by == "agent_proposal" {
            "paused"
        } else {
            "active"
        };
        let item = ObjectiveItem {
            objective_id: format!("objective-{}", uuid::Uuid::new_v4()),
            workspace_id: req.workspace_id.to_owned(),
            project_agent_conversation_id: req.project_agent_conversation_id.trim().to_owned(),
            origin_message_id: req.origin_message_id.trim().to_owned(),
            title: req.title.trim().to_owned(),
            outcome: req.outcome.trim().to_owned(),
            autonomy: req.autonomy.to_owned(),
            created_by: req.created_by.to_owned(),
            watches: req.watches.clone(),
            milestones: req.milestones.clone(),
            success_signals: req.success_signals.clone(),
            budget,
            deadline: req.deadline.map(str::to_owned),
            status: status.to_owned(),
            auto_accept: None,
            auto_accept_approved_by: None,
            pending_confirmation: (req.created_by == "agent_proposal").then_some(true),
            created_at: at.clone(),
            updated_at: at,
            version: 1,
            extra: Map::new(),
        };
        doc.items.push(item.clone());
        if let Some(rid) = req.request_id {
            doc.requests
                .insert(rid.to_owned(), item.objective_id.clone());
        }
        self.save_doc(req.workspace_id, &doc)?;
        Ok((item, false))
    }

    pub fn update_status(
        &self,
        workspace_id: &str,
        objective_id: &str,
        status: &str,
        expected_version: Option<u64>,
    ) -> Result<ObjectiveItem, ProjectError> {
        if !matches!(status, "active" | "paused" | "achieved" | "abandoned") {
            return Err(ProjectError::code("INVALID_STATUS"));
        }
        let mut doc = self.read_doc(workspace_id)?;
        let item = doc
            .items
            .iter_mut()
            .find(|i| i.objective_id == objective_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if let Some(ev) = expected_version
            && item.version != ev
        {
            return Err(ProjectError::code("VERSION_CONFLICT"));
        }
        item.status = status.to_owned();
        item.version += 1;
        item.updated_at = now_iso();
        let out = item.clone();
        self.save_doc(workspace_id, &doc)?;
        Ok(out)
    }

    pub fn update(
        &self,
        workspace_id: &str,
        objective_id: &str,
        patch: &UpdateObjectiveRequest<'_>,
    ) -> Result<ObjectiveItem, ProjectError> {
        if let Some(t) = patch.title
            && (t.trim().is_empty() || t.chars().count() > 120)
        {
            return Err(ProjectError::code("INVALID_OBJECTIVE"));
        }
        if let Some(o) = patch.outcome
            && (o.trim().is_empty() || o.chars().count() > 2000)
        {
            return Err(ProjectError::code("INVALID_OBJECTIVE"));
        }
        if let Some(a) = patch.autonomy
            && !matches!(a, "report_only" | "propose" | "act")
        {
            return Err(ProjectError::code("INVALID_OBJECTIVE"));
        }
        if let Some(ref b) = patch.budget
            && (b.max_auto_sessions_per_day > MAX_AUTO_SESSIONS_PER_DAY
                || b.max_probe_runs_per_day == 0
                || b.max_probe_runs_per_day > MAX_PROBE_RUNS_PER_DAY)
        {
            return Err(ProjectError::code("INVALID_BUDGET"));
        }
        if let Some(Some(dl)) = patch.deadline
            && parse_iso_ms(dl).is_none()
        {
            return Err(ProjectError::code("INVALID_DEADLINE"));
        }
        if let Some(ref w) = patch.watches {
            validate_watches(w)?;
        }

        let mut doc = self.read_doc(workspace_id)?;
        let item = doc
            .items
            .iter_mut()
            .find(|i| i.objective_id == objective_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if let Some(ev) = patch.expected_version
            && item.version != ev
        {
            return Err(ProjectError::code("VERSION_CONFLICT"));
        }
        if let Some(t) = patch.title {
            item.title = t.trim().to_owned();
        }
        if let Some(o) = patch.outcome {
            item.outcome = o.trim().to_owned();
        }
        if let Some(a) = patch.autonomy {
            item.autonomy = a.to_owned();
        }
        if let Some(ref w) = patch.watches {
            item.watches = w.clone();
        }
        if let Some(ref m) = patch.milestones {
            item.milestones = m.clone();
        }
        if let Some(ref s) = patch.success_signals {
            item.success_signals = s.clone();
        }
        if let Some(ref b) = patch.budget {
            item.budget = b.clone();
        }
        if let Some(dl) = patch.deadline {
            item.deadline = dl.map(str::to_owned);
        }
        if let Some(aa) = patch.auto_accept {
            item.auto_accept = Some(aa);
        }
        item.version += 1;
        item.updated_at = now_iso();
        let out = item.clone();
        self.save_doc(workspace_id, &doc)?;
        Ok(out)
    }

    pub fn close(
        &self,
        workspace_id: &str,
        objective_id: &str,
        status: &str,
        evidence_refs: Vec<String>,
    ) -> Result<ObjectiveItem, ProjectError> {
        if !matches!(status, "achieved" | "abandoned") {
            return Err(ProjectError::code("INVALID_STATUS"));
        }
        let cleaned_refs: Vec<String> = evidence_refs
            .into_iter()
            .map(|r| r.trim().to_owned())
            .filter(|r| !r.is_empty() && r.len() <= 500)
            .take(32)
            .collect();
        let mut doc = self.read_doc(workspace_id)?;
        let item = doc
            .items
            .iter_mut()
            .find(|i| i.objective_id == objective_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        item.status = status.to_owned();
        if !cleaned_refs.is_empty() {
            item.extra
                .insert("closeEvidenceRefs".into(), json!(cleaned_refs));
        }
        item.version += 1;
        item.updated_at = now_iso();
        let out = item.clone();
        self.save_doc(workspace_id, &doc)?;
        Ok(out)
    }

    pub fn link_session(
        &self,
        workspace_id: &str,
        objective_id: &str,
        session_id: &str,
        milestone_id: Option<&str>,
    ) -> Result<ObjectiveItem, ProjectError> {
        if !valid_obj_id(session_id) {
            return Err(ProjectError::code("INVALID_SESSION"));
        }
        let mut doc = self.read_doc(workspace_id)?;
        let item = doc
            .items
            .iter_mut()
            .find(|i| i.objective_id == objective_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let target = if let Some(mid) = milestone_id {
            item.milestones
                .iter_mut()
                .find(|m| m.id == mid)
                .ok_or_else(|| ProjectError::code("INVALID_MILESTONE"))?
        } else {
            if item.milestones.is_empty() {
                item.milestones.push(ObjectiveMilestone {
                    id: "work".to_owned(),
                    title: item.title.clone(),
                    status: "active".to_owned(),
                    session_ids: Vec::new(),
                });
            }
            &mut item.milestones[0]
        };
        if !target.session_ids.iter().any(|id| id == session_id) {
            target.session_ids.push(session_id.to_owned());
        }
        item.version += 1;
        item.updated_at = now_iso();
        let out = item.clone();
        self.save_doc(workspace_id, &doc)?;
        Ok(out)
    }

    pub fn observations(
        &self,
        workspace_id: &str,
        objective_id: &str,
    ) -> Result<Vec<WatchObservation>, ProjectError> {
        let path = self.dir(workspace_id)?.join("observations.jsonl");
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        Ok(raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<WatchObservation>(l).ok())
            .filter(|obs| obs.objective_id == objective_id)
            .collect())
    }

    pub fn append_observation(
        &self,
        req: AppendObservationRequest<'_>,
    ) -> Result<(WatchObservation, bool), ProjectError> {
        let obj = self
            .get(req.workspace_id, req.objective_id)?
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if !obj
            .watches
            .iter()
            .any(|w| w["watchId"].as_str() == Some(req.watch_id))
        {
            return Err(ProjectError::code("NOT_FOUND"));
        }
        if req.execution_key.trim().is_empty()
            || req.digest.trim().is_empty()
            || req.summary.trim().is_empty()
            || req.evidence_refs.is_empty()
            || req.evidence_refs.len() > 32
            || !matches!(req.severity, "info" | "notable" | "urgent")
        {
            return Err(ProjectError::code("INVALID_OBSERVATION"));
        }
        let rows = self.observations(req.workspace_id, req.objective_id)?;
        if let Some(prev) = rows.iter().find(|r| r.execution_key == req.execution_key) {
            return Ok((prev.clone(), true));
        }
        let prior = rows.iter().rev().find(|r| r.watch_id == req.watch_id);
        let changed = prior.is_none_or(|p| p.digest != req.digest);
        let obs = WatchObservation {
            objective_id: req.objective_id.to_owned(),
            watch_id: req.watch_id.to_owned(),
            execution_key: req.execution_key.to_owned(),
            digest: req.digest.to_owned(),
            summary: req.summary.chars().take(2000).collect(),
            observed_at: now_iso(),
            evidence_refs: req.evidence_refs,
            severity: req.severity.to_owned(),
            changed,
            previous_digest: prior.map(|p| p.digest.clone()),
            succeeded: req.succeeded,
            value: req.value.map(|v| v.chars().take(2000).collect()),
        };
        let dir = self.dir(req.workspace_id)?;
        fs::create_dir_all(&dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let path = dir.join("observations.jsonl");
        let mut line = serde_json::to_string(&obs)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        line.push('\n');
        let mut handle = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        handle
            .write_all(line.as_bytes())
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        handle
            .sync_all()
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        Ok((obs, false))
    }
}

/// Device-local objective action reservations (`project-runtime/<workspaceId>/objectives/actions-state.json`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectiveActionItem {
    pub action_id: String,
    pub workspace_id: String,
    pub objective_id: String,
    pub version: u64,
    pub event_ids: Vec<String>,
    pub input: Value,
    pub created_at: String,
    pub mode: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reserved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_anchor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ObjectiveActionsDoc {
    schema_version: u32,
    items: Vec<ObjectiveActionItem>,
}

pub struct ObjectiveActions {
    runtime_root: PathBuf,
}

impl ObjectiveActions {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
        }
    }

    fn file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .runtime_root
            .join(workspace_id)
            .join("objectives")
            .join("actions-state.json"))
    }

    fn read_doc(&self, workspace_id: &str) -> Result<ObjectiveActionsDoc, ProjectError> {
        let path = self.file(workspace_id)?;
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ObjectiveActionsDoc {
                    schema_version: 1,
                    items: Vec::new(),
                });
            }
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        let doc: ObjectiveActionsDoc = serde_json::from_str(&raw)
            .map_err(|_| ProjectError::code("CORRUPT_OBJECTIVE_ACTIONS"))?;
        if doc.schema_version != 1 {
            return Err(ProjectError::code("CORRUPT_OBJECTIVE_ACTIONS"));
        }
        Ok(doc)
    }

    fn save_doc(&self, workspace_id: &str, doc: &ObjectiveActionsDoc) -> Result<(), ProjectError> {
        let mut body = serde_json::to_string(doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&self.file(workspace_id)?, body.as_bytes())
    }

    pub fn daily_auto_usage(&self, workspace_id: &str, objective_id: &str) -> usize {
        let today = now_iso();
        let day = &today[..10];
        self.read_doc(workspace_id)
            .map(|doc| {
                doc.items
                    .iter()
                    .filter(|item| {
                        item.objective_id == objective_id
                            && item.mode == "auto"
                            && item
                                .reserved_at
                                .as_deref()
                                .is_some_and(|r| r.starts_with(day))
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    pub fn prepare(
        &self,
        objective: &ObjectiveItem,
        input: Value,
        mut event_ids: Vec<String>,
        force_proposal: bool,
    ) -> Result<(ObjectiveActionItem, bool), ProjectError> {
        if event_ids.is_empty() {
            return Err(ProjectError::code("INVALID_INPUT"));
        }
        event_ids.sort();
        let digest_input = serde_json::to_string(&json!([
            objective.workspace_id,
            objective.objective_id,
            event_ids
        ]))
        .map_err(|_| ProjectError::code("SERIALIZE_ERROR"))?;
        let action_id = format!("action-{:x}", Sha256::digest(digest_input.as_bytes()));
        let mut doc = self.read_doc(&objective.workspace_id)?;
        if let Some(existing) = doc.items.iter().find(|i| i.action_id == action_id) {
            if existing.version != objective.version && existing.state != "spawned" {
                return Err(ProjectError::code("objective_proposal_stale"));
            }
            return Ok((existing.clone(), true));
        }
        let now = now_iso();
        let now_ms = parse_iso_ms(&now).unwrap_or(0);
        let active_proposals = doc
            .items
            .iter()
            .filter(|i| {
                i.state == "proposed"
                    && parse_iso_ms(&i.created_at)
                        .is_some_and(|ms| now_ms.saturating_sub(ms) <= PROPOSAL_TTL_MS)
            })
            .count();
        if active_proposals >= MAX_PENDING_PROPOSALS {
            return Err(ProjectError::code("objective_proposal_capacity"));
        }
        let limit = objective
            .budget
            .max_auto_sessions_per_day
            .min(MAX_AUTO_SESSIONS_PER_DAY) as usize;
        let auto = objective.autonomy == "act"
            && !force_proposal
            && self.daily_auto_usage(&objective.workspace_id, &objective.objective_id) < limit;
        let item = ObjectiveActionItem {
            action_id,
            workspace_id: objective.workspace_id.clone(),
            objective_id: objective.objective_id.clone(),
            version: objective.version,
            event_ids,
            input,
            created_at: now.clone(),
            mode: if auto { "auto" } else { "proposal" }.to_owned(),
            state: if auto { "reserved" } else { "proposed" }.to_owned(),
            reserved_at: auto.then_some(now),
            session_id: None,
            approval_anchor: None,
        };
        doc.items.push(item.clone());
        self.save_doc(&objective.workspace_id, &doc)?;
        Ok((item, false))
    }

    pub fn link_session(
        &self,
        workspace_id: &str,
        action_id: &str,
        session_id: &str,
    ) -> Result<bool, ProjectError> {
        let mut doc = self.read_doc(workspace_id)?;
        let Some(item) = doc.items.iter_mut().find(|i| i.action_id == action_id) else {
            return Ok(false);
        };
        if let Some(ref existing) = item.session_id
            && existing != session_id
        {
            return Err(ProjectError::code("OBJECTIVE_ACTION_SESSION_MISMATCH"));
        }
        item.state = "spawned".to_owned();
        item.session_id = Some(session_id.to_owned());
        self.save_doc(workspace_id, &doc)?;
        Ok(true)
    }

    pub fn list(&self, workspace_id: &str) -> Vec<ObjectiveActionItem> {
        self.read_doc(workspace_id)
            .map(|doc| doc.items)
            .unwrap_or_default()
    }

    pub fn get(&self, workspace_id: &str, action_id: &str) -> Option<ObjectiveActionItem> {
        self.list(workspace_id)
            .into_iter()
            .find(|item| item.action_id == action_id)
    }

    pub fn approve(
        &self,
        workspace_id: &str,
        action_id: &str,
        objective: &ObjectiveItem,
        anchor: &str,
        decline: bool,
    ) -> Result<ObjectiveActionItem, ProjectError> {
        let mut doc = self.read_doc(workspace_id)?;
        let now = now_iso();
        let now_ms = parse_iso_ms(&now).unwrap_or(0);
        let Some(item) = doc.items.iter_mut().find(|i| i.action_id == action_id) else {
            return Err(ProjectError::code("objective_proposal_stale"));
        };
        if item.state == "declined" {
            return Err(ProjectError::code("objective_proposal_declined"));
        }
        let expired = parse_iso_ms(&item.created_at)
            .is_none_or(|created_ms| now_ms.saturating_sub(created_ms) > PROPOSAL_TTL_MS);
        if item.objective_id != objective.objective_id
            || (item.version != objective.version && item.state != "spawned")
            || item.mode != "proposal"
            || expired
        {
            return Err(ProjectError::code("objective_proposal_stale"));
        }
        if item.state == "proposed" {
            item.state = if decline { "declined" } else { "reserved" }.to_owned();
            item.approval_anchor = Some(anchor.to_owned());
            item.reserved_at = Some(now);
            let out = item.clone();
            self.save_doc(workspace_id, &doc)?;
            Ok(out)
        } else {
            Ok(item.clone())
        }
    }

    pub fn pending(&self, workspace_id: &str) -> Vec<ObjectiveActionItem> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        self.read_doc(workspace_id)
            .map(|doc| {
                doc.items
                    .into_iter()
                    .filter(|i| {
                        i.state == "proposed"
                            && parse_iso_ms(&i.created_at)
                                .is_some_and(|ms| now_ms.saturating_sub(ms) <= PROPOSAL_TTL_MS)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn objective_crud_observations_and_daily_budget_work() {
        let dir = tempdir().unwrap();
        let store = ObjectiveStore::new(dir.path());
        let (obj, replayed) = store
            .create(&CreateObjectiveRequest {
                workspace_id: "ws-1",
                project_agent_conversation_id: "conv-1",
                origin_message_id: "input-1",
                title: "Keep CI green",
                outcome: "Monitor main branch CI runs",
                autonomy: "act",
                created_by: "user_request",
                watches: vec![json!({
                    "watchId": "w1",
                    "kind": "schedule",
                    "probe": { "type": "deterministic", "check": "file_hash", "spec": { "path": "Cargo.toml" } }
                })],
                milestones: vec![],
                success_signals: vec![],
                budget: Some(ObjectiveBudget {
                    max_auto_sessions_per_day: 2,
                    max_probe_runs_per_day: 60,
                }),
                deadline: None,
                request_id: Some("req-1"),
            })
            .unwrap();
        assert!(!replayed);
        assert_eq!(obj.status, "active");

        // Idempotent replay by request_id.
        let (obj2, replayed2) = store
            .create(&CreateObjectiveRequest {
                workspace_id: "ws-1",
                project_agent_conversation_id: "conv-1",
                origin_message_id: "input-1",
                title: "Keep CI green",
                outcome: "Monitor main branch CI runs",
                autonomy: "act",
                created_by: "user_request",
                watches: vec![],
                milestones: vec![],
                success_signals: vec![],
                budget: None,
                deadline: None,
                request_id: Some("req-1"),
            })
            .unwrap();
        assert!(replayed2);
        assert_eq!(obj.objective_id, obj2.objective_id);

        let (obs1, _) = store
            .append_observation(AppendObservationRequest {
                workspace_id: "ws-1",
                objective_id: &obj.objective_id,
                watch_id: "w1",
                execution_key: "k1",
                digest: "sha-a",
                summary: "initial hash",
                evidence_refs: vec!["ev-watch-1".into()],
                severity: "info",
                succeeded: Some(true),
                value: None,
            })
            .unwrap();
        assert!(obs1.changed);

        let (obs2, _) = store
            .append_observation(AppendObservationRequest {
                workspace_id: "ws-1",
                objective_id: &obj.objective_id,
                watch_id: "w1",
                execution_key: "k2",
                digest: "sha-a",
                summary: "same hash",
                evidence_refs: vec!["ev-watch-2".into()],
                severity: "info",
                succeeded: Some(true),
                value: None,
            })
            .unwrap();
        assert!(!obs2.changed);
    }
}
