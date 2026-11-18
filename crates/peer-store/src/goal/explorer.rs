//! Explorer lifecycle on the canonical Goal body and existing change journal.
use super::*;
use crate::{DirectoryLock, durable_jsonl as log};
use serde_json::json;
use std::time::Duration;

pub const EXPLORER_TOOL_LIMIT: usize = 4;
pub const EXPLORER_TIMEOUT_MS: u64 = 120_000;
const PLAN_BYTES: usize = 512 * 1024;

pub(super) fn retired(runner: &Value) -> bool {
    runner["nativeExplorerOwner"].is_string()
        && runner["enabled"] == false
        && runner["status"] == "idle"
        && runner["explorers"].as_array().is_some_and(|workers| {
            workers
                .iter()
                .all(|worker| matches!(worker["status"].as_str(), Some("completed" | "failed")))
        })
}

pub struct ExplorerDispatch<'a> {
    pub id: &'a str,
    pub conversation: &'a str,
    pub stream: &'a str,
    pub workspace: &'a Path,
    pub request: &'a Value,
    pub at: &'a str,
    pub inspect: Option<AutomaticInspect<'a>>,
    pub runner: Option<&'a OrdinaryRunner>,
}

pub struct AutomaticInspect<'a> {
    pub goal: &'a LocalGoalIntake,
    pub schedule: &'a Value,
}

pub struct ExplorerLease {
    pub id: String,
    pub plan: String,
    pub title: String,
    pub request: Value,
    revision: String,
    conversation: String,
    stream: String,
    index: Option<files::FileIdentity>,
    intake: Option<LocalGoalIntake>,
    parent_phase: Option<String>,
}

pub enum ExplorerSettlement {
    Completed(Value),
    Failed(&'static str),
}

pub(super) struct PlanWrite<'a> {
    store: &'a GoalStore,
    index: PathBuf,
    before: Option<files::FileIdentity>,
    directory: PathBuf,
    lock: DirectoryLock,
}

impl<'a> PlanWrite<'a> {
    pub(super) fn lock(store: &'a GoalStore) -> Result<Self, GoalError> {
        let directory = log::directory(&store.directory)?;
        let index = directory.join("index.jsonl");
        let lock = DirectoryLock::acquire(&index, Duration::from_millis(100), None)?;
        let before = files::identity(&index)?;
        Ok(Self {
            store,
            index,
            before,
            directory,
            lock,
        })
    }

    pub(super) fn publish(
        self,
        id: &str,
        revision: &str,
        plan: &Value,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(String, Option<files::FileIdentity>), GoalError> {
        let mut index = log::read(&self.index, None)?;
        let mut rows = index.iter_mut().filter(|row| row["planId"] == id);
        let row = rows.next().ok_or(GoalError::Changed)?;
        if rows.next().is_some() || row["conversationId"] != plan["conversationId"] {
            return Err(GoalError::Changed);
        }
        row["updatedAt"] = json!(at);
        row["status"] = plan["status"].clone();
        let index = log::encode(&index)?;
        let bytes = serde_json::to_vec(plan).map_err(|_| GoalError::Invalid)?;
        if bytes.len() > PLAN_BYTES {
            return Err(GoalError::Limit);
        }
        let journal = self.directory.join(".changes.jsonl");
        super::ordinary_create::notification_exists(&journal, None, None)?;
        let time = time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339)
            .map_err(|_| GoalError::Invalid)?
            .unix_timestamp_nanos()
            / 1_000_000;
        let notification = log::encode(&[json!({"reason":"persist","changeKind":"runner-state",
            "planId":id,"conversationId":plan["conversationId"],"revision":format!("{time}-{}", uuid::Uuid::new_v4()),
            "changedAt":at,"writerPid":std::process::id()})])?;
        admit().map_err(GoalError::Projection)?;
        if files::identity(&self.index)? != self.before || self.store.revision(id)? != revision {
            return Err(GoalError::Changed);
        }
        self.lock.check_owned()?;
        log::replace(&self.directory.join(format!("{id}.json")), &bytes, None)?;
        let uncertain = |_| GoalError::Store(StoreError::CommitUncertain);
        log::replace(&self.index, &index, None).map_err(uncertain)?;
        log::append_to_limit(&journal, &notification, u64::MAX, None).map_err(uncertain)?;
        let revision = self
            .store
            .revision(id)
            .map_err(|_| GoalError::Store(StoreError::CommitUncertain))?;
        let index = files::identity(&self.index).map_err(uncertain)?;
        self.lock.release().map_err(uncertain)?;
        Ok((revision, index))
    }
}

impl GoalStore {
    pub fn begin_explorer(
        &self,
        dispatch: ExplorerDispatch<'_>,
        projector: &impl GoalFactProjector,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Option<ExplorerLease>, GoalError> {
        if !valid_id(dispatch.id, false)
            || !valid_id(dispatch.stream, false)
            || !dispatch.request.is_object()
        {
            return Err(GoalError::Invalid);
        }
        let intake = match &dispatch.inspect {
            Some(inspect) if inspect.goal.workspace == dispatch.workspace => inspect.goal.clone(),
            Some(_) => return Err(GoalError::Changed),
            None => {
                let Some(intake) = self.observe_local_intake(
                    dispatch.conversation,
                    dispatch.workspace,
                    projector,
                    None,
                )?
                else {
                    return Ok(None);
                };
                intake
            }
        };
        let transaction = PlanWrite::lock(self)?;
        self.check_local_intake(&intake)?;
        let plan_id = intake.plan_id.clone();
        let snapshot = self.read_bounded(&plan_id, projector, None, PLAN_BYTES as u64)?;
        let mut plan = self.read_context(&plan_id, &snapshot.source_revision)?;
        let parent_phase = dispatch
            .runner
            .filter(|runner| {
                runner.owns(&plan) && super::runner::valid_runner_owner(&plan, dispatch.stream)
            })
            .and_then(|_| plan["runner"]["phase"].as_str())
            .map(str::to_owned);
        if plan["conversationId"] != dispatch.conversation
            || plan["originWorkspacePath"].as_str().map(Path::new) != Some(dispatch.workspace)
            || !plan["parentPlanId"].is_null()
            || !plan["delegationOrigin"].is_null()
            || dispatch.runner.is_some() && parent_phase.is_none()
            || snapshot.facts["runner"].is_object()
                && parent_phase.is_none()
                && (snapshot.facts["runner"]["status"] != "idle" || !retired(&plan["runner"]))
        {
            return Err(GoalError::Projection(
                "explorer_goal_owned_by_another_execution",
            ));
        }
        if !plan["runner"].is_object() {
            plan["runner"] = json!({"turnCount":0,"roundCount":0,"toolCallCount":0,"explorers":[]});
        }
        let runner = &mut plan["runner"];
        let explorers = runner["explorers"]
            .as_array_mut()
            .ok_or(GoalError::Invalid)?;
        if explorers.iter().any(|row| row["explorerId"] == dispatch.id) {
            return Err(GoalError::Projection("explorer_dispatch_limit"));
        }
        let mut request = dispatch.request.clone();
        request["explorerId"] = json!(dispatch.id);
        request["planId"] = json!(plan_id);
        request["profile"] = json!("readonly_explorer");
        request["budget"] =
            json!({"maxToolCalls":EXPLORER_TOOL_LIMIT,"maxDurationMs":EXPLORER_TIMEOUT_MS});
        request["createdAt"] = json!(dispatch.at);
        explorers.push(
            json!({"explorerId":dispatch.id,"request":request,"status":"running",
            "createdAt":dispatch.at,"updatedAt":dispatch.at}),
        );
        runner["explorerCount"] = json!(explorers.len());
        runner["enabled"] = json!(true);
        runner["status"] = json!("exploring");
        runner["intent"] = json!("explore");
        runner["phase"] = json!("inspect");
        if let Some(inspect) = &dispatch.inspect {
            runner["inspectPlan"] = inspect.schedule.clone();
        }
        runner["nativeExplorerOwner"] = json!(dispatch.stream);
        runner["updatedAt"] = json!(dispatch.at);
        plan["updatedAt"] = json!(dispatch.at);
        let title = plan["title"].as_str().ok_or(GoalError::Invalid)?.to_owned();
        let (revision, index) = transaction.publish(
            &plan_id,
            &snapshot.source_revision,
            &plan,
            dispatch.at,
            admit,
        )?;
        Ok(Some(ExplorerLease {
            id: dispatch.id.into(),
            plan: plan_id,
            title,
            request,
            revision,
            conversation: dispatch.conversation.into(),
            stream: dispatch.stream.into(),
            index,
            intake: dispatch.inspect.map(|_| intake),
            parent_phase,
        }))
    }

    pub fn check_explorer(&self, lease: &ExplorerLease) -> Result<(), GoalError> {
        if self.revision(&lease.plan)? != lease.revision
            || files::identity(&self.directory.join("index.jsonl"))? != lease.index
        {
            return Err(GoalError::Changed);
        }
        Ok(())
    }

    pub fn finish_explorer(
        &self,
        lease: &ExplorerLease,
        result: ExplorerSettlement,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Option<LocalGoalIntake>, GoalError> {
        let transaction = PlanWrite::lock(self)?;
        self.check_explorer(lease)?;
        let mut plan = self.read_context(&lease.plan, &lease.revision)?;
        if plan["conversationId"] != lease.conversation
            || plan["runner"]["status"] != "exploring"
            || plan["runner"]["nativeExplorerOwner"] != lease.stream
        {
            return Err(GoalError::Changed);
        }
        let runner = &mut plan["runner"];
        let worker = runner["explorers"]
            .as_array_mut()
            .and_then(|rows| {
                rows.iter_mut()
                    .find(|row| row["explorerId"] == lease.id && row["status"] == "running")
            })
            .ok_or(GoalError::Changed)?;
        worker["updatedAt"] = json!(at);
        match result {
            ExplorerSettlement::Completed(report) => {
                worker["status"] = json!("completed");
                worker["report"] = report;
                runner["status"] = json!(if lease.parent_phase.is_some() {
                    "running"
                } else {
                    "idle"
                });
                runner["enabled"] = json!(lease.parent_phase.is_some());
                runner["intent"] = json!("execute");
                runner["phase"] = json!(lease.parent_phase.as_deref().unwrap_or("plan_scaffold"));
            }
            ExplorerSettlement::Failed(reason) => {
                worker["status"] = json!("failed");
                worker["failureReason"] = json!(reason);
                runner["status"] = json!(if lease.parent_phase.is_some() {
                    "running"
                } else {
                    "blocked"
                });
                runner["intent"] = json!(if lease.parent_phase.is_some() {
                    "execute"
                } else {
                    "block"
                });
                runner["phase"] = json!(lease.parent_phase.as_deref().unwrap_or("blocked"));
                runner["blockedReason"] = json!(reason);
            }
        }
        runner["updatedAt"] = json!(at);
        plan["updatedAt"] = json!(at);
        let (plan_revision, index) =
            transaction.publish(&lease.plan, &lease.revision, &plan, at, admit)?;
        Ok(lease.intake.clone().map(|intake| LocalGoalIntake {
            plan_revision,
            index_revision: files::fingerprint(&[index]),
            ..intake
        }))
    }

    pub fn recover_stopped_explorer(
        &self,
        run: &peer_protocol::ConversationExecution,
        at: &str,
        confirm: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), GoalError> {
        if !run
            .stop
            .as_ref()
            .is_some_and(|stop| stop.runner_idle && stop.admission_closed && stop.handles_ended)
            || !run.handles.is_empty()
        {
            return Ok(());
        }
        let index = self.directory.join("index.jsonl");
        let before = files::identity(&index)?;
        let mut owned = None;
        for entry in log::read(&index, None)?
            .iter()
            .filter(|entry| entry["conversationId"] == run.identity.conversation_id)
        {
            let id = entry["planId"].as_str().ok_or(GoalError::Invalid)?;
            let revision = self.revision(id)?;
            let plan = self.read_context(id, &revision)?;
            let runner = &plan["runner"];
            if plan["conversationId"] != run.identity.conversation_id
                || runner["nativeExplorerOwner"] != run.identity.stream_id
                || runner["status"] != "exploring"
            {
                continue;
            }
            let mut workers = runner["explorers"]
                .as_array()
                .ok_or(GoalError::Invalid)?
                .iter()
                .filter(|worker| worker["status"] == "running");
            let worker = workers.next().ok_or(GoalError::Invalid)?;
            if workers.next().is_some() || owned.is_some() {
                return Err(GoalError::Changed);
            }
            owned = Some(ExplorerLease {
                id: worker["explorerId"]
                    .as_str()
                    .ok_or(GoalError::Invalid)?
                    .to_owned(),
                plan: id.to_owned(),
                title: String::new(),
                request: Value::Null,
                revision,
                conversation: run.identity.conversation_id.clone(),
                stream: run.identity.stream_id.clone(),
                index: before.clone(),
                intake: None,
                parent_phase: (runner["nativeRunnerOwner"] == run.identity.stream_id)
                    .then(|| "inspect".to_owned()),
            });
        }
        if let Some(lease) = owned {
            self.check_explorer(&lease)?;
            self.finish_explorer(
                &lease,
                ExplorerSettlement::Failed("explorer_owner_interrupted"),
                at,
                confirm,
            )?;
        }
        Ok(())
    }
}
