//! Durable per-project execution queue & slot scheduler (`project-runtime/<workspaceId>/scheduler.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/execution-scheduler.mjs` (ADR 80 §5):
//! - Global model-turn concurrency semaphore (1..=8, default 4).
//! - Per-project execution slots: up to 2 read-only tasks, 1 in-place write task,
//!   and unlimited isolated worktree write tasks.
//! - Priority (`high` > `normal` > `low`) with 30-minute aging promotion.
//! - `dependsOn` dependencies require completed + accepted predecessor sessions.

use crate::{ProjectError, atomic_write, is_valid_workspace_id, now_iso, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Semaphore;

const AGING_MS: i64 = 30 * 60_000;
const MAX_QUEUE_ITEMS: usize = 10_000;

pub fn normalize_concurrency(value: Option<usize>) -> usize {
    match value {
        Some(n) if (1..=8).contains(&n) => n,
        _ => 4,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Read,
    Write,
    Isolated,
}

impl SlotKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Isolated => "isolated",
        }
    }

    pub fn limit(self) -> usize {
        match self {
            Self::Read => 2,
            Self::Write => 1,
            Self::Isolated => usize::MAX,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub session_id: String,
    pub order: u64,
    pub enqueued_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerFile {
    version: u32,
    items: Vec<QueueEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedBehind {
    pub session_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleDecision {
    pub allowed: bool,
    pub reason: Option<String>,
    pub queued_behind: Vec<QueuedBehind>,
}

#[derive(Debug, Clone)]
pub struct SelectionOutcome {
    pub start: Vec<String>,
    pub blocked: Vec<String>,
}

pub fn slot_of(plan: &Value) -> SlotKind {
    if plan["delegationOrigin"]["readOnly"] == true {
        return SlotKind::Read;
    }
    if plan["deliveryBinding"]["executionIsolation"] == "worktree"
        && plan["deliveryBinding"]["worktreePath"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty())
    {
        return SlotKind::Isolated;
    }
    SlotKind::Write
}

fn is_terminal(plan: &Value) -> bool {
    matches!(
        plan["status"].as_str(),
        Some("completed" | "failed" | "cancelled")
    )
}

fn is_failed(plan: &Value) -> bool {
    matches!(plan["status"].as_str(), Some("failed" | "cancelled"))
}

fn is_occupying(plan: &Value) -> bool {
    let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
    if phase != "running" || is_terminal(plan) || is_failed(plan) {
        return false;
    }
    if slot_of(plan) == SlotKind::Read {
        let waiting = plan["runner"]["status"] == "waiting_user"
            || plan["delegationOrigin"]["agentWaitMessageId"]
                .as_str()
                .is_some_and(|s| !s.is_empty());
        if waiting {
            return false;
        }
    }
    true
}

fn priority_rank(priority: Option<&str>, enqueued_at: &str, now_ms: i64) -> u8 {
    let base: u8 = match priority.unwrap_or("normal") {
        "high" => 2,
        "low" => 0,
        _ => 1,
    };
    let aged =
        parse_iso_ms(enqueued_at).is_some_and(|ms| now_ms.saturating_sub(ms) >= AGING_MS) as u8;
    (base + aged).min(2)
}

pub struct ExecutionScheduler {
    runtime_root: PathBuf,
    global_turns: Arc<Semaphore>,
    concurrency: usize,
}

impl ExecutionScheduler {
    pub fn new(data_home: impl AsRef<Path>, concurrency: Option<usize>) -> Self {
        let limit = normalize_concurrency(concurrency);
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
            global_turns: Arc::new(Semaphore::new(limit)),
            concurrency: limit,
        }
    }

    pub fn concurrency(&self) -> usize {
        self.concurrency
    }

    pub fn global_semaphore(&self) -> Arc<Semaphore> {
        Arc::clone(&self.global_turns)
    }

    fn file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self.runtime_root.join(workspace_id).join("scheduler.json"))
    }

    pub fn load_queue(&self, workspace_id: &str) -> Vec<QueueEntry> {
        let Ok(path) = self.file(workspace_id) else {
            return Vec::new();
        };
        let Ok(raw) = fs::read_to_string(path) else {
            return Vec::new();
        };
        let Ok(parsed) = serde_json::from_str::<SchedulerFile>(&raw) else {
            return Vec::new();
        };
        if parsed.version != 1 {
            return Vec::new();
        }
        parsed
            .items
            .into_iter()
            .take(MAX_QUEUE_ITEMS)
            .filter(|i| !i.session_id.is_empty() && parse_iso_ms(&i.enqueued_at).is_some())
            .collect()
    }

    fn save_queue(&self, workspace_id: &str, items: &[QueueEntry]) -> Result<(), ProjectError> {
        let path = self.file(workspace_id)?;
        let doc = SchedulerFile {
            version: 1,
            items: items.to_vec(),
        };
        let body = serde_json::to_string(&doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        if fs::read_to_string(&path).ok().as_deref() == Some(body.as_str()) {
            return Ok(());
        }
        atomic_write(&path, body.as_bytes())
    }

    /// Reconciles durable queue order against current queued plans for `workspace_id`.
    pub fn reconcile(
        &self,
        workspace_id: &str,
        plans: &[Value],
    ) -> Result<Vec<QueueEntry>, ProjectError> {
        let mut pending: Vec<&Value> = plans
            .iter()
            .filter(|p| {
                p["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id)
                    && p["delegationOrigin"]["phase"] == "queued"
                    && p["runner"]["status"] != "waiting_user"
                    && !is_terminal(p)
            })
            .collect();
        pending.sort_by(|a, b| {
            let ca = a["createdAt"].as_str().unwrap_or("");
            let cb = b["createdAt"].as_str().unwrap_or("");
            ca.cmp(cb)
        });
        let active_ids: HashSet<&str> = pending
            .iter()
            .filter_map(|p| p["delegationOrigin"]["sessionId"].as_str())
            .collect();
        let old = self.load_queue(workspace_id);
        let mut next_order = old.iter().map(|i| i.order).max().map_or(0, |m| m + 1);
        let mut items: Vec<QueueEntry> = old
            .into_iter()
            .filter(|i| active_ids.contains(i.session_id.as_str()))
            .collect();
        let mut known: HashSet<String> = items.iter().map(|i| i.session_id.clone()).collect();
        let at = now_iso();
        for plan in pending {
            let Some(sid) = plan["delegationOrigin"]["sessionId"].as_str() else {
                continue;
            };
            if known.insert(sid.to_owned()) {
                items.push(QueueEntry {
                    session_id: sid.to_owned(),
                    order: next_order,
                    enqueued_at: at.clone(),
                });
                next_order += 1;
            }
        }
        self.save_queue(workspace_id, &items)?;
        Ok(items)
    }

    /// Evaluates whether `plan` can start given dependencies, isolation blocks, and slots.
    pub fn inspect(&self, plan: &Value, all_plans: &[Value]) -> ScheduleDecision {
        let origin = &plan["delegationOrigin"];
        let ws = origin["workspaceId"].as_str().unwrap_or("");
        let same_project: Vec<&Value> = all_plans
            .iter()
            .filter(|p| p["delegationOrigin"]["workspaceId"].as_str() == Some(ws))
            .collect();
        let by_session: HashMap<&str, &Value> = same_project
            .iter()
            .filter_map(|p| p["delegationOrigin"]["sessionId"].as_str().map(|s| (s, *p)))
            .collect();

        if let Some(deps) = origin["dependsOn"].as_array() {
            let mut dep_plans = Vec::new();
            for dep in deps {
                let Some(dep_id) = dep.as_str() else { continue };
                let Some(mut found) = by_session.get(dep_id).copied() else {
                    return ScheduleDecision {
                        allowed: false,
                        reason: Some("dependency_missing".to_owned()),
                        queued_behind: Vec::new(),
                    };
                };
                // A bounded automatic retry inherits the exact predecessor task.
                // Dependents follow that replacement while it remains pending.
                for _ in 0..crate::supervisor::autonomy::MAX_AUTONOMOUS_RETRIES {
                    let origin = &found["delegationOrigin"];
                    let Some(next) = origin["supersededBy"]
                        .as_str()
                        .and_then(|id| by_session.get(id).copied())
                        .filter(|next| {
                            let next_origin = &next["delegationOrigin"];
                            next_origin["autonomousRetry"] == true
                                && next_origin["supersedes"] == origin["sessionId"]
                                && next_origin["parentConversationId"]
                                    == origin["parentConversationId"]
                        })
                    else {
                        break;
                    };
                    found = next;
                }
                dep_plans.push(found);
            }
            let failed_deps: Vec<QueuedBehind> = dep_plans
                .iter()
                .filter(|p| is_failed(p))
                .map(|p| QueuedBehind {
                    session_id: p["delegationOrigin"]["sessionId"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                    title: p["title"].as_str().unwrap_or("").to_owned(),
                })
                .collect();
            if !failed_deps.is_empty() {
                return ScheduleDecision {
                    allowed: false,
                    reason: Some("dependency_failed".to_owned()),
                    queued_behind: failed_deps,
                };
            }
            let unmet: Vec<QueuedBehind> = dep_plans
                .iter()
                .filter(|p| {
                    p["status"] != "completed"
                        || p["resultAcceptance"]["acceptedAt"].as_str().is_none()
                })
                .map(|p| QueuedBehind {
                    session_id: p["delegationOrigin"]["sessionId"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned(),
                    title: p["title"].as_str().unwrap_or("").to_owned(),
                })
                .collect();
            if !unmet.is_empty() {
                return ScheduleDecision {
                    allowed: false,
                    reason: Some("dependencies".to_owned()),
                    queued_behind: unmet,
                };
            }
        }

        if let Some(block) = origin["isolationBlock"].as_str().filter(|s| !s.is_empty()) {
            return ScheduleDecision {
                allowed: false,
                reason: Some(block.to_owned()),
                queued_behind: Vec::new(),
            };
        }

        let kind = slot_of(plan);
        let occupants: Vec<QueuedBehind> = same_project
            .iter()
            .filter(|p| p["planId"] != plan["planId"] && is_occupying(p) && slot_of(p) == kind)
            .map(|p| QueuedBehind {
                session_id: p["delegationOrigin"]["sessionId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned(),
                title: p["title"].as_str().unwrap_or("").to_owned(),
            })
            .collect();
        if occupants.len() >= kind.limit() {
            return ScheduleDecision {
                allowed: false,
                reason: Some(format!("{}_slot", kind.as_str())),
                queued_behind: occupants,
            };
        }

        ScheduleDecision {
            allowed: true,
            reason: None,
            queued_behind: Vec::new(),
        }
    }

    /// Selects which queued sessions in `workspace_id` can be promoted to `running`.
    pub fn select(
        &self,
        workspace_id: &str,
        plans: &[Value],
    ) -> Result<SelectionOutcome, ProjectError> {
        let queue = self.reconcile(workspace_id, plans)?;
        let meta: HashMap<&str, &QueueEntry> =
            queue.iter().map(|e| (e.session_id.as_str(), e)).collect();
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let mut candidates: Vec<&Value> = plans
            .iter()
            .filter(|p| {
                p["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id)
                    && p["delegationOrigin"]["sessionId"]
                        .as_str()
                        .is_some_and(|s| meta.contains_key(s))
            })
            .collect();
        candidates.sort_by(|a, b| {
            let sa = a["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
            let sb = b["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
            let ma = meta[sa];
            let mb = meta[sb];
            let ra = priority_rank(
                a["delegationOrigin"]["priority"].as_str(),
                &ma.enqueued_at,
                now_ms,
            );
            let rb = priority_rank(
                b["delegationOrigin"]["priority"].as_str(),
                &mb.enqueued_at,
                now_ms,
            );
            rb.cmp(&ra)
                .then_with(|| ma.enqueued_at.cmp(&mb.enqueued_at))
                .then_with(|| ma.order.cmp(&mb.order))
                .then_with(|| {
                    a["planId"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["planId"].as_str().unwrap_or(""))
                })
        });

        let mut virtual_plans = plans.to_vec();
        let mut start = Vec::new();
        let mut blocked = Vec::new();
        for cand in candidates {
            let dec = self.inspect(cand, &virtual_plans);
            let sid = cand["delegationOrigin"]["sessionId"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            if matches!(
                dec.reason.as_deref(),
                Some("dependency_failed" | "dependency_missing")
            ) {
                blocked.push(sid);
                continue;
            }
            if dec.allowed {
                let pid = cand["planId"].as_str().unwrap_or("");
                if let Some(slot_plan) = virtual_plans.iter_mut().find(|p| p["planId"] == pid) {
                    slot_plan["delegationOrigin"]["phase"] = serde_json::json!("running");
                }
                start.push(sid);
            }
        }
        Ok(SelectionOutcome { start, blocked })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn scheduler_enforces_write_slot_read_slots_isolated_worktrees_and_dependencies() {
        let dir = tempdir().unwrap();
        let sched = ExecutionScheduler::new(dir.path(), Some(4));
        let plans = vec![
            json!({
                "planId": "p-write-1", "title": "W1", "status": "executing", "createdAt": "2026-11-19T01:00:00.000Z",
                "delegationOrigin": {"workspaceId": "ws-1", "sessionId": "s-w1", "phase": "queued", "readOnly": false, "priority": "normal"}
            }),
            json!({
                "planId": "p-write-2", "title": "W2", "status": "executing", "createdAt": "2026-11-19T01:00:01.000Z",
                "delegationOrigin": {"workspaceId": "ws-1", "sessionId": "s-w2", "phase": "queued", "readOnly": false, "priority": "normal"}
            }),
            json!({
                "planId": "p-iso", "title": "Iso", "status": "executing", "createdAt": "2026-11-19T01:00:02.000Z",
                "deliveryBinding": {"executionIsolation": "worktree", "worktreePath": "/tmp/wt-iso"},
                "delegationOrigin": {"workspaceId": "ws-1", "sessionId": "s-iso", "phase": "queued", "readOnly": false, "priority": "normal"}
            }),
            json!({
                "planId": "p-dep", "title": "Dep", "status": "executing", "createdAt": "2026-11-19T01:00:03.000Z",
                "delegationOrigin": {"workspaceId": "ws-1", "sessionId": "s-dep", "phase": "queued", "readOnly": true, "dependsOn": ["s-w1"]}
            }),
        ];
        let sel = sched.select("ws-1", &plans).unwrap();
        // s-w1 takes the 1 write slot; s-w2 waits; s-iso uses unlimited isolated slot; s-dep waits on s-w1.
        assert!(sel.start.contains(&"s-w1".to_owned()));
        assert!(sel.start.contains(&"s-iso".to_owned()));
        assert!(!sel.start.contains(&"s-w2".to_owned()));
        assert!(!sel.start.contains(&"s-dep".to_owned()));
    }
}
