//! Delegated work-session supervisor: spawns canonical `GoalPlan`s + child conversations,
//! schedules slots/worktrees, drives worker episodes via `NativeSessionHost`, evaluates
//! host Evidence verdicts & policy/user acceptance, and emits canonical inbox events.
//!
//! Matches `packages/runtime-node/src/project-agent/session-supervisor.mjs` (ADR 80, 85, 88, 91, 103, 116).

use crate::{
    BotListSession, BotProfileStore, ProjectError, ProjectInbox,
    acceptance::{
        AcceptanceDecision, AcceptanceFacts, HostAuthorityFacts, compute_verification_verdict,
        decide_session_acceptance,
    },
    atomic_write,
    memory::create_snapshot,
    now_iso,
    scheduler::{ExecutionScheduler, SelectionOutcome},
    worktree::{GoalWorktreeAdapter, HandoffOutcome, WorktreeHandle},
};
use peer_runtime::{
    CancellationToken,
    native_exec::{execute_plan, recover_plan},
    session_host::{EpisodeOutcome, PermissionInput},
};
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, DirectoryLock,
    EvidenceIndexStore, HostApproval, NewProjectConversation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnCriterion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnSessionRequest {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub parent_conversation_id: String,
    pub anchor_message_ids: Vec<String>,
    pub input_id: String,
    pub surface: String,
    pub title: String,
    pub brief: String,
    pub kind: String,
    pub read_only: bool,
    pub required_capabilities: Vec<String>,
    pub success_criteria: Vec<SpawnCriterion>,
    pub priority: String,
    pub depends_on: Vec<String>,
    pub supersedes: Option<String>,
    pub objective_id: Option<String>,
    pub isolation: String,
    pub worker_model_selection: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionSummary {
    pub session_id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    pub plan_id: String,
    pub title: String,
    pub status: String,
    pub phase: String,
    pub read_only: bool,
    pub priority: String,
    pub updated_at: String,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionReport {
    pub summary: WorkSessionSummary,
    pub task_brief: String,
    pub evidence_refs: Vec<String>,
    pub changed_files: Vec<String>,
    pub verdict_outcome: String,
    pub independent_verifier: String,
    pub worker_output: String,
}

pub struct SessionSupervisor {
    data_home: PathBuf,
    goal_plans_dir: PathBuf,
    conversations: ConversationStore,
    approvals: ApprovalStore,
    profiles: BotProfileStore,
    inbox: ProjectInbox,
    scheduler: ExecutionScheduler,
    worktrees: GoalWorktreeAdapter,
}

fn plan_approval_required(policy: &str, read_only: bool) -> bool {
    match policy {
        "always" => true,
        "writes" => !read_only,
        _ => false,
    }
}

fn derive_session_status(plan: &Value) -> String {
    if plan["delegationOrigin"]["supersededBy"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return "superseded".to_owned();
    }
    if plan["resultAcceptance"]["acceptedAt"].as_str().is_some() {
        return "accepted".to_owned();
    }
    match plan["status"].as_str().unwrap_or("") {
        "cancelled" => "cancelled".to_owned(),
        "failed" => "failed".to_owned(),
        "completed" => "result_ready".to_owned(),
        "awaiting_approval" => "waiting_user".to_owned(),
        _ => match plan["delegationOrigin"]["phase"]
            .as_str()
            .unwrap_or("queued")
        {
            "paused" => "paused".to_owned(),
            "awaiting_approval" => "waiting_user".to_owned(),
            "verifying" => "verifying".to_owned(),
            "running" => {
                if plan["runner"]["status"] == "waiting_user" {
                    "waiting_user".to_owned()
                } else {
                    "running".to_owned()
                }
            }
            "starting" => "starting".to_owned(),
            _ => "queued".to_owned(),
        },
    }
}

impl SessionSupervisor {
    pub fn new(data_home: impl AsRef<Path>, concurrency: Option<usize>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            goal_plans_dir: home.join("goal-plans"),
            conversations: ConversationStore::new(&home),
            approvals: ApprovalStore::new(&home),
            profiles: BotProfileStore::new(&home),
            inbox: ProjectInbox::new(&home),
            scheduler: ExecutionScheduler::new(&home, concurrency),
            worktrees: GoalWorktreeAdapter::new(&home, None),
            data_home: home,
        }
    }

    pub fn scheduler(&self) -> &ExecutionScheduler {
        &self.scheduler
    }

    fn plan_file(&self, plan_id: &str) -> PathBuf {
        self.goal_plans_dir.join(format!("{plan_id}.json"))
    }

    fn index_file(&self) -> PathBuf {
        self.goal_plans_dir.join("index.jsonl")
    }

    pub fn read_plan(&self, plan_id: &str) -> Result<Value, ProjectError> {
        let path = self.plan_file(plan_id);
        let raw = fs::read_to_string(&path).map_err(|_| ProjectError::code("NOT_FOUND"))?;
        serde_json::from_str(&raw).map_err(|_| ProjectError::code("GOAL_SOURCE_INVALID"))
    }

    fn write_plan(&self, plan: &Value) -> Result<(), ProjectError> {
        let plan_id = plan["planId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        fs::create_dir_all(&self.goal_plans_dir)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let index_path = self.index_file();
        let _lock = DirectoryLock::acquire(&index_path, LOCK_TIMEOUT, None)?;
        let body = serde_json::to_string_pretty(plan)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        atomic_write(&self.plan_file(plan_id), format!("{body}\n").as_bytes())?;

        let mut rows: Vec<Value> = fs::read_to_string(&index_path)
            .ok()
            .map(|raw| {
                raw.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                    .collect()
            })
            .unwrap_or_default();
        let index_row = json!({
            "planId": plan_id,
            "conversationId": plan["conversationId"],
            "title": plan["title"],
            "status": plan["status"],
            "createdAt": plan["createdAt"],
            "updatedAt": plan["updatedAt"],
        });
        if let Some(slot) = rows.iter_mut().find(|r| r["planId"] == plan_id) {
            *slot = index_row;
        } else {
            rows.push(index_row);
        }
        let mut encoded = String::new();
        for row in rows {
            if let Ok(line) = serde_json::to_string(&row) {
                encoded.push_str(&line);
                encoded.push('\n');
            }
        }
        atomic_write(&index_path, encoded.as_bytes())
    }

    pub fn list_workspace_plans(&self, workspace_id: &str) -> Vec<Value> {
        let Ok(raw) = fs::read_to_string(self.index_file()) else {
            return Vec::new();
        };
        let mut plans = Vec::new();
        for line in raw.lines() {
            let Ok(row) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let Some(pid) = row["planId"].as_str() else {
                continue;
            };
            if let Ok(plan) = self.read_plan(pid)
                && plan["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id)
            {
                plans.push(plan);
            }
        }
        plans
    }

    fn summarize(&self, plan: &Value) -> WorkSessionSummary {
        let origin = &plan["delegationOrigin"];
        WorkSessionSummary {
            session_id: origin["sessionId"]
                .as_str()
                .or_else(|| plan["conversationId"].as_str())
                .unwrap_or("")
                .to_owned(),
            workspace_id: origin["workspaceId"].as_str().unwrap_or("").to_owned(),
            conversation_id: plan["conversationId"].as_str().unwrap_or("").to_owned(),
            plan_id: plan["planId"].as_str().unwrap_or("").to_owned(),
            title: plan["title"].as_str().unwrap_or("").to_owned(),
            status: derive_session_status(plan),
            phase: origin["phase"].as_str().unwrap_or("queued").to_owned(),
            read_only: origin["readOnly"] == true,
            priority: origin["priority"].as_str().unwrap_or("normal").to_owned(),
            updated_at: plan["updatedAt"].as_str().unwrap_or("").to_owned(),
            accepted: plan["resultAcceptance"]["acceptedAt"].as_str().is_some(),
            accepted_by: plan["resultAcceptance"]["acceptedBy"]
                .as_str()
                .map(str::to_owned),
            worktree_path: plan["deliveryBinding"]["worktreePath"]
                .as_str()
                .map(str::to_owned),
            approval_id: origin["planApprovalId"].as_str().map(str::to_owned),
        }
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Vec<WorkSessionSummary> {
        let mut items: Vec<WorkSessionSummary> = self
            .list_workspace_plans(workspace_id)
            .iter()
            .map(|p| self.summarize(p))
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn list_bot_sessions(&self, workspace_id: &str) -> Vec<BotListSession> {
        self.list_sessions(workspace_id)
            .into_iter()
            .map(|s| BotListSession {
                session_id: s.session_id,
                title: s.title,
                status: s.status,
                updated_at: Some(s.updated_at),
                result_confirmation_required: None,
                completion_review_required: false,
            })
            .collect()
    }

    pub fn find_plan_by_session(&self, workspace_id: &str, session_id: &str) -> Option<Value> {
        self.list_workspace_plans(workspace_id)
            .into_iter()
            .find(|p| {
                p["delegationOrigin"]["sessionId"].as_str() == Some(session_id)
                    || p["conversationId"].as_str() == Some(session_id)
                    || p["planId"].as_str() == Some(session_id)
            })
    }

    fn emit_event(&self, workspace_id: &str, kind: &str, session_id: &str, payload: Value) {
        let at = now_iso();
        let event_id = format!("sup-{kind}-{session_id}-{}", uuid::Uuid::new_v4());
        let _ = self.inbox.append(
            workspace_id,
            &[json!({
                "eventId": event_id,
                "kind": kind,
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "at": at,
                "payload": payload,
            })],
        );
    }

    /// Spawn a delegated work session: freezes memory snapshot, creates child conversation
    /// + canonical GoalPlan + optional isolated worktree + optional plan approval gate.
    pub fn spawn_session(
        &self,
        req: SpawnSessionRequest,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if req.anchor_message_ids.is_empty()
            || req.title.trim().is_empty()
            || req.title.chars().count() > 60
            || req.brief.trim().is_empty()
            || req.brief.chars().count() > 4000
            || req.success_criteria.is_empty()
            || req.success_criteria.len() > 8
        {
            return Err(ProjectError::code("invalid_input"));
        }
        let at = now_iso();
        let snapshot = create_snapshot(&self.data_home, &req.workspace_id)?;
        let plan_id = format!("plan-{}", uuid::Uuid::new_v4());
        let conv = self.conversations.create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: req.title.trim(),
                workspace_id: &req.workspace_id,
                workspace_path: req.workspace_path.to_str(),
                role: "work_session",
                parent_conversation_id: Some(&req.parent_conversation_id),
                mode: "goal",
                created_at: &at,
            },
            None,
            None,
        )?;
        let session_id = conv["id"]
            .as_str()
            .ok_or_else(|| ProjectError::code("CONVERSATION_CREATE_FAILED"))?
            .to_owned();

        // Append the delegated brief as the opening user message in the child conversation.
        self.conversations.append_message_idempotent(
            &session_id,
            &json!({
                "id": format!("brief-{session_id}"),
                "role": "user",
                "content": req.brief,
                "createdAt": at,
            }),
            &at,
            None,
        )?;

        let use_worktree = !req.read_only
            && (req.isolation == "worktree"
                || (req.isolation == "auto"
                    && GoalWorktreeAdapter::is_git_repository(&req.workspace_path)));
        let delivery_binding = if use_worktree {
            match self
                .worktrees
                .prepare(&plan_id, &req.workspace_path, Some(&req.title))
            {
                Ok(handle) => json!({
                    "executionIsolation": "worktree",
                    "targetWorkspacePath": req.workspace_path,
                    "worktreePath": handle.worktree_path,
                    "branch": handle.branch,
                    "targetBranch": handle.target_branch,
                    "targetBranchSource": "workspace_head",
                    "baselineCommit": handle.baseline_commit,
                }),
                Err(_) => json!({
                    "executionIsolation": "none",
                    "targetWorkspacePath": req.workspace_path,
                }),
            }
        } else {
            json!({
                "executionIsolation": "none",
                "targetWorkspacePath": req.workspace_path,
            })
        };

        let profile = self.profiles.read(&req.workspace_id);
        let plan_approval_policy = profile
            .as_ref()
            .map(|p| p.plan_approval_str())
            .unwrap_or("never");
        let needs_plan_approval = plan_approval_required(plan_approval_policy, req.read_only);
        let approval_id = needs_plan_approval.then(|| format!("plan:{plan_id}"));

        let criteria: Vec<Value> = req
            .success_criteria
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut row = json!({
                    "id": c.id.clone().unwrap_or_else(|| format!("c-{}", i + 1)),
                    "kind": c.kind,
                    "description": c.description,
                });
                if let Some(ref cmd) = c.command {
                    row["command"] = json!(cmd);
                }
                if let Some(ref p) = c.path {
                    row["path"] = json!(p);
                }
                if let Some(ref exp) = c.expect {
                    row["expect"] = json!(exp);
                }
                row
            })
            .collect();

        let execution_generation = uuid::Uuid::new_v4().to_string();
        let initial_phase = if needs_plan_approval {
            "awaiting_approval"
        } else {
            "queued"
        };
        let initial_status = if needs_plan_approval {
            "awaiting_approval"
        } else {
            "accepted"
        };
        let mut origin = json!({
            "workspaceId": req.workspace_id,
            "sessionId": session_id,
            "parentConversationId": req.parent_conversation_id,
            "anchorMessageId": req.anchor_message_ids[0],
            "anchorMessageIds": req.anchor_message_ids,
            "inputId": req.input_id,
            "surface": req.surface,
            "kind": req.kind,
            "readOnly": req.read_only,
            "requiredCapabilities": req.required_capabilities,
            "memorySnapshotId": snapshot.snapshot_id,
            "priority": req.priority,
            "dependsOn": req.depends_on,
            "isolation": req.isolation,
            "phase": initial_phase,
            "executionGeneration": execution_generation,
            "depth": 1,
            "modelSelection": {
                "worker": req.worker_model_selection,
            }
        });
        if let Some(ref obj_id) = req.objective_id {
            origin["objectiveId"] = json!(obj_id);
        }
        if let Some(ref aid) = approval_id {
            origin["planApprovalId"] = json!(aid);
        }

        let plan = json!({
            "planId": plan_id,
            "conversationId": session_id,
            "originWorkspacePath": req.workspace_path,
            "targetWorkspacePath": delivery_binding["worktreePath"].as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| req.workspace_path.clone()),
            "title": req.title.trim(),
            "goal": req.brief.trim(),
            "tasks": [{
                "taskId": "task-1",
                "title": req.title.trim(),
                "status": "pending",
                "evidenceRefs": [],
            }],
            "successCriteria": criteria,
            "status": initial_status,
            "workflowKind": if needs_plan_approval { "plan_approval" } else { "goal_self_driven" },
            "activation": if needs_plan_approval {
                json!({"kind": "approval_required"})
            } else {
                json!({"kind": "accepted_goal", "acceptedAt": at, "acceptedBy": "delegation"})
            },
            "deliveryBinding": delivery_binding,
            "delegationOrigin": origin,
            "executionPolicy": {
                "autonomy": if needs_plan_approval { "approval_gated" } else { "self_driven" },
                "irreversibleRequiresConfirmation": true,
                "writeScope": "workspace_and_boundaries",
            },
            "version": 1,
            "createdAt": at,
            "updatedAt": at,
            "createdBy": "project_agent",
            "criterionResults": [],
            "modelReviews": [],
            "manualConfirmations": [],
            "evidenceRefs": [],
            "progress": {"total": 1, "completed": 0, "failed": 0, "blocked": 0, "percent": 0},
        });
        self.write_plan(&plan)?;

        if let Some(ref aid) = approval_id {
            let digest = format!("{:x}", Sha256::digest(plan_id.as_bytes()));
            self.approvals.open(
                &HostApproval {
                    approval_id: aid,
                    workspace_id: Some(&req.workspace_id),
                    conversation_id: &session_id,
                    stream_id: &execution_generation,
                    plan_id: Some(&plan_id),
                    session_id: Some(&session_id),
                    capability_id: "goal.plan",
                    args_digest: &digest,
                    policy_revision: "1",
                    created_at: &at,
                    deadline_at: None,
                },
                None,
            )?;
        }

        // ADR 80: supersede old session ONLY after the replacement session is durably created.
        if let Some(ref old_sid) = req.supersedes
            && let Some(mut old_plan) = self.find_plan_by_session(&req.workspace_id, old_sid)
        {
            let old_status = derive_session_status(&old_plan);
            if !matches!(old_status.as_str(), "result_ready" | "accepted") {
                old_plan["delegationOrigin"]["phase"] = json!("paused");
                old_plan["delegationOrigin"]["supersededBy"] = json!(session_id);
                old_plan["delegationOrigin"]["supersededAt"] = json!(at);
                old_plan["updatedAt"] = json!(at);
                let _ = self.write_plan(&old_plan);
            }
        }

        let all_plans = self.list_workspace_plans(&req.workspace_id);
        let _ = self.scheduler.reconcile(&req.workspace_id, &all_plans);
        self.emit_event(
            &req.workspace_id,
            "session_spawned",
            &session_id,
            json!({"planId": plan_id, "title": req.title, "phase": initial_phase}),
        );
        Ok(self.summarize(&plan))
    }

    /// Promote eligible queued sessions according to `ExecutionScheduler`.
    pub fn promote_queued(
        &self,
        workspace_id: &str,
        holds_lease: bool,
    ) -> Result<SelectionOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let all_plans = self.list_workspace_plans(workspace_id);
        let outcome = self.scheduler.select(workspace_id, &all_plans)?;
        let at = now_iso();
        for sid in &outcome.start {
            if let Some(mut plan) = self.find_plan_by_session(workspace_id, sid) {
                plan["delegationOrigin"]["phase"] = json!("running");
                plan["status"] = json!("executing");
                plan["updatedAt"] = json!(at);
                self.write_plan(&plan)?;
                self.emit_event(
                    workspace_id,
                    "session_running",
                    sid,
                    json!({"planId": plan["planId"]}),
                );
            }
        }
        Ok(outcome)
    }

    /// Execute one delegated session episode via the existing native `NativeSessionHost`
    /// (`peer_runtime::native_exec::execute_plan`), honoring all Grants, Evidence, MCP, Hooks,
    /// Skills, Compaction, Billing, and Stop/Recovery invariants.
    pub async fn run_session_episode(
        &self,
        workspace_id: &str,
        session_id: &str,
        permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
        holds_lease: bool,
    ) -> Result<EpisodeOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let _permit = self
            .scheduler
            .global_semaphore()
            .acquire_owned()
            .await
            .map_err(|_| ProjectError::code("SCHEDULER_CLOSED"))?;
        let outcome =
            execute_plan(&self.data_home, &plan_id, permission, max_turns, cancel).await?;
        let at = now_iso();
        if let Ok(mut updated) = self.read_plan(&plan_id) {
            let final_status = match outcome.status {
                "completed" => "completed",
                "cancelled" => "cancelled",
                _ => "failed",
            };
            updated["status"] = json!(final_status);
            updated["updatedAt"] = json!(at);
            updated["delegationOrigin"]["lastWorkerOutput"] = json!(outcome.content);
            if final_status == "completed" {
                let ev_refs = self.indexed_evidence_refs(&plan_id);
                if let Some(tasks) = updated["tasks"].as_array_mut() {
                    for t in tasks {
                        t["status"] = json!("completed");
                        if !ev_refs.is_empty() {
                            let list: Vec<String> = ev_refs.iter().cloned().collect();
                            t["evidenceRefs"] = json!(list);
                        }
                    }
                }
            }
            let _ = self.write_plan(&updated);
            self.emit_event(
                workspace_id,
                if final_status == "completed" {
                    "report_available"
                } else {
                    "session_ended"
                },
                session_id,
                json!({"planId": plan_id, "status": final_status}),
            );
        }
        Ok(outcome)
    }

    pub fn indexed_evidence_refs(&self, plan_id: &str) -> HashSet<String> {
        let store = EvidenceIndexStore::new(&self.data_home);
        store
            .list_for_plan(plan_id, None)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|row| row["evidenceRef"].as_str().map(str::to_owned))
            .collect()
    }

    /// Evaluate verification verdict + acceptance decision from canonical plan & host Evidence index,
    /// persisting `resultAcceptance` when either policy auto-accepts or user explicitly confirms.
    pub fn settle_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        reported: bool,
        user_confirm: bool,
        independent_verifier: Option<&str>,
        holds_lease: bool,
    ) -> Result<AcceptanceDecision, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"].as_str().unwrap_or("").to_owned();
        let evidence = self.indexed_evidence_refs(&plan_id);
        let profile = self.profiles.read(workspace_id);
        let policy = profile
            .as_ref()
            .map(|p| p.acceptance_policy_str())
            .unwrap_or("auto");
        let read_only = plan["delegationOrigin"]["readOnly"] == true;
        let changed_files = self.session_changed_files(&plan);
        let anchor_text = plan["goal"].as_str().unwrap_or("");
        let manual_pending = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| {
                let cid = c["id"].as_str().unwrap_or("");
                c["kind"] == "manual"
                    && !plan["manualConfirmations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|m| {
                            m["criterionId"].as_str() == Some(cid) && m["decision"] == "confirmed"
                        })
            });
        let verifier_state = independent_verifier
            .map(str::to_owned)
            .or_else(|| {
                plan["delegationOrigin"]["independentVerifier"]
                    .as_str()
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| {
                if read_only {
                    "not_required".to_owned()
                } else {
                    "missing".to_owned()
                }
            });

        let decision = decide_session_acceptance(
            &AcceptanceFacts {
                plan: &plan,
                session_id,
                evidence_index: &evidence,
                host_authority: HostAuthorityFacts {
                    independent_verifier: Some(verifier_state.clone()),
                    ..Default::default()
                },
                policy,
                reported,
                read_only,
                changed_files,
                manual_criteria_pending: manual_pending,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text,
                verification_below_floor: false,
            },
            user_confirm,
        );

        let at = now_iso();
        plan["delegationOrigin"]["independentVerifier"] = json!(verifier_state);
        if let Some(ref by) = decision.accepted_by {
            plan["resultAcceptance"] = json!({
                "acceptedAt": at,
                "acceptedBy": by,
                "verdictRef": decision.verdict_ref,
                "mode": decision.mode,
            });
            plan["updatedAt"] = json!(at);
            self.write_plan(&plan)?;
            self.emit_event(
                workspace_id,
                "session_verified",
                session_id,
                json!({
                    "planId": plan_id,
                    "verdict": decision.verdict.outcome,
                    "acceptedBy": by,
                }),
            );
        }
        Ok(decision)
    }

    pub fn read_report(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<WorkSessionReport, ProjectError> {
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"].as_str().unwrap_or("");
        let evidence = self.indexed_evidence_refs(plan_id);
        let verdict = compute_verification_verdict(
            &plan,
            &evidence,
            &HostAuthorityFacts {
                independent_verifier: plan["delegationOrigin"]["independentVerifier"]
                    .as_str()
                    .map(str::to_owned),
                ..Default::default()
            },
        );
        Ok(WorkSessionReport {
            summary: self.summarize(&plan),
            task_brief: plan["goal"].as_str().unwrap_or("").to_owned(),
            evidence_refs: verdict.evidence_refs,
            changed_files: self.session_changed_files(&plan),
            verdict_outcome: verdict.outcome,
            independent_verifier: verdict.independent_verifier,
            worker_output: plan["delegationOrigin"]["lastWorkerOutput"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        })
    }

    fn session_changed_files(&self, plan: &Value) -> Vec<String> {
        let binding = &plan["deliveryBinding"];
        if binding["executionIsolation"] != "worktree" {
            return Vec::new();
        }
        let Some(wt) = binding["worktreePath"].as_str() else {
            return Vec::new();
        };
        let Some(ws) = binding["targetWorkspacePath"].as_str() else {
            return Vec::new();
        };
        let Some(baseline) = binding["baselineCommit"].as_str() else {
            return Vec::new();
        };
        let handle = WorktreeHandle {
            workspace_path: PathBuf::from(ws),
            worktree_path: PathBuf::from(wt),
            repository_root: PathBuf::from(ws),
            branch: binding["branch"].as_str().unwrap_or("").to_owned(),
            target_branch: binding["targetBranch"].as_str().unwrap_or("").to_owned(),
            baseline_commit: baseline.to_owned(),
        };
        self.worktrees.changed_files(&handle)
    }

    pub fn handoff_worktree(
        &self,
        workspace_id: &str,
        session_id: &str,
        holds_lease: bool,
    ) -> Result<HandoffOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if plan["resultAcceptance"]["acceptedAt"].as_str().is_none() {
            return Ok(HandoffOutcome::Stopped {
                reason: "acceptance_required",
                detail: "session must be accepted before merging worktree".to_owned(),
            });
        }
        let binding = &plan["deliveryBinding"];
        let Some(wt) = binding["worktreePath"].as_str() else {
            return Ok(HandoffOutcome::NothingToMerge);
        };
        let ws = binding["targetWorkspacePath"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        let handle = WorktreeHandle {
            workspace_path: PathBuf::from(ws),
            worktree_path: PathBuf::from(wt),
            repository_root: PathBuf::from(ws),
            branch: binding["branch"].as_str().unwrap_or("").to_owned(),
            target_branch: binding["targetBranch"].as_str().unwrap_or("").to_owned(),
            baseline_commit: binding["baselineCommit"].as_str().unwrap_or("").to_owned(),
        };
        self.worktrees.handoff_merge(&handle)
    }

    pub fn decide_plan_approval(
        &self,
        workspace_id: &str,
        approval_id: &str,
        approve: bool,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let rows = self.approvals.list(Some(workspace_id), None)?;
        let expected = rows
            .iter()
            .find(|r| r["approvalId"].as_str() == Some(approval_id))
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let at = now_iso();
        let state = if approve {
            ApprovalState::Approved
        } else {
            ApprovalState::Denied
        };
        self.approvals.decide(
            expected,
            state,
            ApprovalDecision::LocalUser,
            &at,
            (!approve).then_some("local_user_denied"),
            None,
        )?;
        let plan_id = expected["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let mut plan = self.read_plan(plan_id)?;
        if approve {
            plan["status"] = json!("accepted");
            plan["approval"] = json!({
                "decision": "approved",
                "approvalId": approval_id,
                "decidedAt": at,
                "decidedBy": "local_ui",
            });
            plan["delegationOrigin"]["phase"] = json!("queued");
        } else {
            plan["status"] = json!("cancelled");
            plan["delegationOrigin"]["phase"] = json!("cancelled");
        }
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    pub fn control_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        action: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let current = derive_session_status(&plan);
        if matches!(current.as_str(), "result_ready" | "accepted") {
            return Err(ProjectError::code("session_already_completed"));
        }
        let at = now_iso();
        match action {
            "pause" => {
                plan["delegationOrigin"]["phase"] = json!("paused");
                plan["updatedAt"] = json!(at);
            }
            "resume" => {
                plan["delegationOrigin"]["phase"] = json!("queued");
                if plan["status"] == "paused" {
                    plan["status"] = json!("accepted");
                }
                plan["updatedAt"] = json!(at);
            }
            "cancel" => {
                plan["status"] = json!("cancelled");
                plan["delegationOrigin"]["phase"] = json!("cancelled");
                plan["delegationOrigin"]["cancellation"] = json!({
                    "operationId": uuid::Uuid::new_v4().to_string(),
                    "reason": reason,
                    "phase": "completed",
                    "requestedAt": at,
                    "completedAt": at,
                });
                plan["updatedAt"] = json!(at);
            }
            _ => return Err(ProjectError::code("invalid_action")),
        }
        self.write_plan(&plan)?;
        if action == "cancel" {
            self.emit_event(
                workspace_id,
                "session_ended",
                session_id,
                json!({"status": "cancelled", "reason": reason}),
            );
        }
        Ok(self.summarize(&plan))
    }

    pub fn reprioritize_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        priority: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if !matches!(priority, "high" | "normal" | "low") {
            return Err(ProjectError::code("invalid_priority"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        plan["delegationOrigin"]["priority"] = json!(priority);
        plan["updatedAt"] = json!(now_iso());
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    pub fn message_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        text: &str,
        intent: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if !matches!(intent, "answer" | "amend") || text.trim().is_empty() {
            return Err(ProjectError::code("invalid_input"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let status = derive_session_status(&plan);
        if matches!(
            status.as_str(),
            "accepted" | "cancelled" | "failed" | "superseded"
        ) {
            return Err(ProjectError::code("session_terminal"));
        }
        let conv_id = plan["conversationId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let at = now_iso();
        let content = if intent == "amend" {
            format!("来自项目代理转达：{text}")
        } else {
            text.to_owned()
        };
        self.conversations.append_message_idempotent(
            &conv_id,
            &json!({
                "id": format!("msg-{}", uuid::Uuid::new_v4()),
                "role": "user",
                "kind": if intent == "amend" { "user_correction" } else { "user_input" },
                "content": content,
                "createdAt": at,
            }),
            &at,
            None,
        )?;
        if plan["runner"]["status"] == "waiting_user" {
            plan["runner"]["status"] = json!("running");
            plan["delegationOrigin"]["phase"] = json!("queued");
        }
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    /// Startup recovery for an owned workspace: marks orphaned `open` approvals as `stale`/`expired`,
    /// reconciles scheduler queue, and runs native plan recovery on interrupted delegated plans.
    pub async fn recover_workspace(
        &self,
        workspace_id: &str,
        cancel: &CancellationToken,
        holds_lease: bool,
    ) -> Result<usize, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let at = now_iso();
        let _ = self
            .approvals
            .recover_owned(Some(workspace_id), &at, None)?;
        let plans = self.list_workspace_plans(workspace_id);
        let _ = self.scheduler.reconcile(workspace_id, &plans)?;
        let mut recovered = 0usize;
        for plan in &plans {
            let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
            let pid = plan["planId"].as_str().unwrap_or("");
            if phase == "running"
                && !pid.is_empty()
                && recover_plan(&self.data_home, pid, cancel).await.is_ok()
            {
                recovered += 1;
            }
        }
        Ok(recovered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateBotProfile;
    use tempfile::tempdir;

    #[test]
    fn supervisor_spawns_approves_promotes_and_controls_sessions() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let convs = ConversationStore::new(dir.path());
        let at = now_iso();
        let parent = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Main Bot",
                    workspace_id: "ws-1",
                    workspace_path: ws.to_str(),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: &at,
                },
                None,
                None,
            )
            .unwrap();
        let parent_id = parent["id"].as_str().unwrap().to_owned();
        let profiles = BotProfileStore::new(dir.path());
        let (mut prof, _) = profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Main Bot",
                managed: false,
                agent_conversation_id: &parent_id,
                avatar_salt: "",
            })
            .unwrap();
        prof.plan_approval = Some("writes".into());
        profiles.save(prof).unwrap();

        let sup = SessionSupervisor::new(dir.path(), Some(4));
        let spawned = sup
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: "ws-1".into(),
                    workspace_path: ws,
                    parent_conversation_id: parent_id,
                    anchor_message_ids: vec!["input-1".into()],
                    input_id: "1".into(),
                    surface: "tui".into(),
                    title: "Write hello".into(),
                    brief: "Create hello.txt".into(),
                    kind: "code".into(),
                    read_only: false,
                    required_capabilities: vec!["local.file.write".into()],
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "file-exists".into(),
                        description: "hello.txt exists".into(),
                        command: None,
                        path: Some("hello.txt".into()),
                        expect: None,
                    }],
                    priority: "high".into(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "none".into(),
                    worker_model_selection: json!({"providerId":"env","model":"test"}),
                },
                true,
            )
            .unwrap();
        assert_eq!(spawned.status, "waiting_user");
        let aid = spawned.approval_id.clone().unwrap();

        // Approve the plan -> moves to queued -> promote moves to running.
        let approved = sup.decide_plan_approval("ws-1", &aid, true, true).unwrap();
        assert_eq!(approved.phase, "queued");
        let promoted = sup.promote_queued("ws-1", true).unwrap();
        assert_eq!(promoted.start, vec![spawned.session_id.clone()]);

        // Cancel cleanly records cancellation.
        let cancelled = sup
            .control_session("ws-1", &spawned.session_id, "cancel", "user_stop", true)
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
    }
}
