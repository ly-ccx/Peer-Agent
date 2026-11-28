//! Model-facing task changes. The host and store own evidence and publication.
use super::*;
use crate::{ConversationStore, DirectoryLock, EvidenceIndexStore, durable_jsonl as log};
use peer_protocol::{collect_tool_result_evidence_refs, javascript_trim};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashSet, time::Duration};

pub struct GoalTaskPublication<'a> {
    pub conversation: &'a str,
    pub workspace: &'a Path,
    pub tool_call_id: &'a str,
    pub at: &'a str,
    pub runner: Option<&'a OrdinaryRunner>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    WaitingUser,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::WaitingUser => "waiting_user",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CriterionChange {
    criterion_id: String,
    passed: bool,
    evidence_ref: Option<String>,
    detail: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoalTaskChange {
    plan_id: String,
    task_id: String,
    status: Option<TaskStatus>,
    #[serde(default)]
    evidence_refs: Vec<String>,
    result: Option<String>,
    failure_reason: Option<String>,
    blocked_reason: Option<String>,
    #[serde(default)]
    criterion_results: Vec<CriterionChange>,
}

fn optional(value: &mut Option<String>) {
    *value = value
        .as_deref()
        .map(javascript_trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
}

impl GoalTaskChange {
    pub fn parse(args: &Value) -> Result<Self, GoalError> {
        if serde_json::to_vec(args)
            .map_err(|_| GoalError::Invalid)?
            .len()
            > 256 * 1024
        {
            return Err(GoalError::Limit);
        }
        let mut change: Self =
            serde_json::from_value(args.clone()).map_err(|_| GoalError::Invalid)?;
        change.plan_id = javascript_trim(&change.plan_id).to_owned();
        change.task_id = javascript_trim(&change.task_id).to_owned();
        if !valid_id(&change.plan_id, false)
            || change.task_id.is_empty()
            || change.task_id.len() > 200
            || change.evidence_refs.len() > 128
            || change.criterion_results.len() > 128
        {
            return Err(GoalError::Invalid);
        }
        for reference in &mut change.evidence_refs {
            *reference = javascript_trim(reference).to_owned();
            if reference.is_empty() || reference.len() > 8192 {
                return Err(GoalError::Invalid);
            }
        }
        optional(&mut change.result);
        optional(&mut change.failure_reason);
        optional(&mut change.blocked_reason);
        for criterion in &mut change.criterion_results {
            criterion.criterion_id = javascript_trim(&criterion.criterion_id).to_owned();
            optional(&mut criterion.detail);
            optional(&mut criterion.evidence_ref);
            if criterion.criterion_id.is_empty()
                || criterion.criterion_id.len() > 200
                || criterion
                    .evidence_ref
                    .as_ref()
                    .is_some_and(|r| r.len() > 8192)
            {
                return Err(GoalError::Invalid);
            }
        }
        Ok(change)
    }

    pub fn apply(
        &self,
        mut plan: Value,
        at: &str,
        resolve: impl Fn(&[String]) -> Result<HashSet<String>, GoalError>,
    ) -> Result<Value, GoalError> {
        let awaiting = matches!(
            plan["status"].as_str(),
            Some("drafting" | "awaiting_approval")
        );
        if awaiting
            && self
                .status
                .is_some_and(|status| status != TaskStatus::Pending)
        {
            return Err(GoalError::Projection("goal_plan_approval_required"));
        }
        let task = find_task(&mut plan["tasks"], &self.task_id)?
            .ok_or(GoalError::Projection("goal_task_not_found"))?;
        if task["subtasks"]
            .as_array()
            .is_some_and(|children| !children.is_empty())
            || task["executionMode"] == "delegated"
            || task["childPlanIds"]
                .as_array()
                .is_some_and(|ids| !ids.is_empty())
        {
            return Err(GoalError::Projection(
                "goal_task_owned_by_another_execution",
            ));
        }
        let old_refs = task["evidenceRefs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        let mut merged = Vec::new();
        let mut seen = HashSet::new();
        for reference in old_refs.chain(self.evidence_refs.iter().map(String::as_str)) {
            if seen.insert(reference) {
                merged.push(reference.to_owned());
            }
        }
        let complete = self.status == Some(TaskStatus::Completed);
        let active_criteria: Vec<_> = self
            .criterion_results
            .iter()
            .filter_map(|result| {
                plan["successCriteria"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|criterion| criterion["id"] == result.criterion_id)
                    .map(|criterion| (result, criterion["kind"].as_str().unwrap_or("manual")))
            })
            .collect();
        let mut to_resolve = if complete {
            merged.clone()
        } else {
            self.evidence_refs.clone()
        };
        to_resolve.extend(
            active_criteria
                .iter()
                .filter_map(|(change, _)| change.evidence_ref.clone()),
        );
        let available = if to_resolve.is_empty() {
            HashSet::new()
        } else {
            resolve(&to_resolve)?
        };
        if complete && !merged.iter().any(|reference| available.contains(reference)) {
            return Err(GoalError::Projection(
                "goal_task_completion_requires_evidence",
            ));
        }
        if self
            .evidence_refs
            .iter()
            .any(|reference| !available.contains(reference))
        {
            return Err(GoalError::Projection("goal_task_evidence_unverified"));
        }
        let previous_criteria = plan["criterionResults"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let next_criteria = apply_criteria(previous_criteria, active_criteria, &available, at)?;
        let task = find_task(&mut plan["tasks"], &self.task_id)?.ok_or(GoalError::Invalid)?;
        let status = self
            .status
            .map(TaskStatus::as_str)
            .unwrap_or_else(|| task["status"].as_str().unwrap_or("pending"))
            .to_owned();
        let row = task.as_object_mut().ok_or(GoalError::Invalid)?;
        let status_changed = row.get("status").and_then(Value::as_str) != Some(status.as_str());
        row.insert("status".into(), json!(status));
        if !merged.is_empty() {
            row.insert("evidenceRefs".into(), json!(merged));
        }
        if let Some(result) = &self.result {
            row.insert("result".into(), json!(result));
        }
        if let Some(reason) = &self.failure_reason {
            row.insert("failureReason".into(), json!(reason));
        } else if status == "completed" {
            row.remove("failureReason");
        }
        if let Some(reason) = &self.blocked_reason {
            row.insert("blockedReason".into(), json!(reason));
        } else if status != "waiting_user" {
            row.remove("blockedReason");
        }
        if self.status == Some(TaskStatus::Running)
            && row.get("startedAt").is_none_or(Value::is_null)
        {
            row.insert("startedAt".into(), json!(at));
        }
        if matches!(
            self.status,
            Some(TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled)
        ) && (status_changed || row.get("completedAt").is_none_or(Value::is_null))
        {
            row.insert("completedAt".into(), json!(at));
        }
        if !next_criteria.is_empty() {
            plan["criterionResults"] = json!(next_criteria);
        }
        Ok(plan)
    }
}

fn find_task<'a>(tasks: &'a mut Value, id: &str) -> Result<Option<&'a mut Value>, GoalError> {
    let mut found = None;
    for task in tasks.as_array_mut().ok_or(GoalError::Invalid)? {
        let matches = task["taskId"] == id;
        let candidate = if matches {
            Some(task)
        } else if let Some(children) = task.get_mut("subtasks") {
            find_task(children, id)?
        } else {
            None
        };
        if let Some(task) = candidate
            && found.replace(task).is_some()
        {
            return Err(GoalError::Invalid);
        }
    }
    Ok(found)
}

fn apply_criteria(
    mut rows: Vec<Value>,
    changes: Vec<(&CriterionChange, &str)>,
    available: &HashSet<String>,
    at: &str,
) -> Result<Vec<Value>, GoalError> {
    for (change, kind) in changes {
        if kind == "model_review" {
            return Err(GoalError::Projection("model_review_requires_host_verifier"));
        }
        let automatic = ["command", "test", "file-exists", "file-contains"].contains(&kind);
        if (automatic && change.passed && change.evidence_ref.is_none())
            || change
                .evidence_ref
                .as_ref()
                .is_some_and(|reference| !available.contains(reference))
        {
            return Err(GoalError::Projection("goal_criterion_evidence_unverified"));
        }
        let mut row =
            json!({"criterionId":change.criterion_id,"passed":change.passed,"checkedAt":at});
        if let Some(reference) = &change.evidence_ref {
            row["evidenceRef"] = json!(reference);
        }
        if let Some(detail) = &change.detail {
            row["detail"] = json!(detail);
        }
        if let Some(existing) = rows
            .iter_mut()
            .find(|old| old["criterionId"] == change.criterion_id)
        {
            if ["passed", "evidenceRef", "detail"]
                .into_iter()
                .all(|key| existing[key] == row[key])
            {
                continue;
            }
            let existing = existing.as_object_mut().ok_or(GoalError::Invalid)?;
            existing.remove("evidenceRef");
            existing.remove("detail");
            existing.extend(row.as_object().ok_or(GoalError::Invalid)?.clone());
        } else {
            rows.push(row);
        }
    }
    Ok(rows)
}

pub(super) fn observed_evidence(
    home: &Path,
    conversation: &str,
    plan: &str,
    refs: &[String],
    cancel: Option<&AtomicBool>,
) -> Result<HashSet<String>, GoalError> {
    observed_scoped_evidence(home, conversation, plan, refs, cancel, None)
}

pub(super) struct VerifierEvidence<'a> {
    pub id: &'a str,
    pub stream: &'a str,
}

pub(super) fn observed_scoped_evidence(
    home: &Path,
    conversation: &str,
    plan: &str,
    refs: &[String],
    cancel: Option<&AtomicBool>,
    verifier: Option<VerifierEvidence<'_>>,
) -> Result<HashSet<String>, GoalError> {
    let refs: Vec<_> = refs
        .iter()
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let records = EvidenceIndexStore::new(home).find(&refs, cancel)?;
    let records: Vec<_> = records
        .iter()
        .filter(|row| {
            row["conversationId"] == conversation
                && row["planId"].as_str().is_none_or(|owner| owner == plan)
                && verifier
                    .as_ref()
                    .is_none_or(|scope| row["planId"] == plan && row["streamId"] == scope.stream)
                && row["toolCallId"].is_string()
                && row["capabilityId"]
                    .as_str()
                    .is_some_and(|capability| !capability.starts_with("local.goal."))
        })
        .collect();
    if records.is_empty() {
        return Ok(HashSet::new());
    }
    let store = ConversationStore::new(home);
    let pending = store.read_conversation_execution(conversation)?;
    let history = store.read_committed(conversation, None, log::MAX_BYTES)?;
    let mut found = HashSet::new();
    for msg in &history.history.messages {
        log::check_cancel(cancel)?;
        if msg["role"] != "assistant" || msg["pending"] == true {
            continue;
        }
        if verifier.as_ref().is_some_and(|scope| {
            msg["nativeVerifierId"] != scope.id
                || msg["nativeGoalPlanId"] != plan
                || msg["streamId"] != scope.stream
                || msg["kind"] != "agent_activity"
        }) {
            continue;
        }
        for segment in msg["segments"].as_array().into_iter().flatten() {
            if segment["type"] != "tool-call" {
                continue;
            }
            let Some(call) = segment["toolCallId"].as_str() else {
                continue;
            };
            if verifier.as_ref().is_some_and(|scope| {
                !msg["permissionGrants"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|grant| {
                        grant["toolCallId"] == call
                            && grant["granted"] == true
                            && grant["metadata"]["readonlyWorkerId"] == scope.id
                    })
            }) {
                continue;
            }
            if pending.as_ref().is_some_and(|run| {
                run.pending_tools
                    .iter()
                    .any(|active| active.tool_call_id == call)
            }) {
                continue;
            }
            for row in records.iter().filter(|row| row["toolCallId"] == call) {
                let reference = row["evidenceRef"].as_str().ok_or(GoalError::Invalid)?;
                if supports_reference(msg, segment, row, call, reference)? {
                    found.insert(reference.to_owned());
                }
            }
        }
    }
    Ok(found)
}

fn leaf_states(tasks: &Value, states: &mut Vec<String>) -> Result<(), GoalError> {
    for task in tasks.as_array().ok_or(GoalError::Invalid)? {
        if task["subtasks"]
            .as_array()
            .is_some_and(|children| !children.is_empty())
        {
            leaf_states(&task["subtasks"], states)?;
        } else {
            states.push(task["status"].as_str().ok_or(GoalError::Invalid)?.into());
        }
    }
    Ok(())
}

fn next_status(plan: &Value) -> Result<&str, GoalError> {
    let prior = plan["status"].as_str().ok_or(GoalError::Invalid)?;
    let mut states = Vec::new();
    leaf_states(&plan["tasks"], &mut states)?;
    let terminal = |state: &String| matches!(state.as_str(), "completed" | "failed" | "cancelled");
    Ok(match prior {
        "accepted" | "approved" if states.iter().any(|state| state != "pending") => "executing",
        "executing" if !states.is_empty() && states.iter().all(terminal) => {
            if states.iter().any(|state| state == "failed") {
                "failed"
            } else {
                "completed"
            }
        }
        _ => prior,
    })
}

fn timestamp(value: &str) -> Result<i128, GoalError> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map(|time| time.unix_timestamp_nanos() / 1_000_000)
        .map_err(|_| GoalError::Projection("GOAL_TIMESTAMP_UNSUPPORTED"))
}

pub(super) fn transition_plan(plan: &mut Value, at: &str) -> Result<(), GoalError> {
    let next = next_status(plan)?;
    if plan["status"] == next {
        return Ok(());
    }
    let now = timestamp(at)?;
    let mut timing = plan["timing"].as_object().cloned().unwrap_or_default();
    let active = timing
        .get("activeAccumulatedMs")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    timing.insert("activeAccumulatedMs".into(), json!(active));
    if next == "executing" {
        for key in ["startedAt", "activeSegmentStartedAt"] {
            timing.entry(key).or_insert_with(|| json!(at));
        }
        for key in ["completedAt", "wallClockMs", "activeMs"] {
            timing.remove(key);
        }
    } else {
        let elapsed = |value: Option<&Value>| -> Result<u64, GoalError> {
            value
                .and_then(Value::as_str)
                .map(timestamp)
                .transpose()
                .map(|start| {
                    start.map_or(0, |start| {
                        u64::try_from((now - start).max(0)).unwrap_or(u64::MAX)
                    })
                })
        };
        let active =
            active.saturating_add(elapsed(timing.remove("activeSegmentStartedAt").as_ref())?);
        let wall_clock = elapsed(timing.get("startedAt"))?;
        timing.insert("activeAccumulatedMs".into(), json!(active));
        timing.insert("completedAt".into(), json!(at));
        timing.insert("activeMs".into(), json!(active));
        timing.insert("wallClockMs".into(), json!(wall_clock));
    }
    plan["status"] = json!(next);
    plan["timing"] = Value::Object(timing);
    Ok(())
}

impl GoalStore {
    pub fn publish_ordinary_task_change(
        &self,
        args: &Value,
        publication: GoalTaskPublication<'_>,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Value, GoalError> {
        let missing = GoalError::Projection("goal_plan_not_found");
        let change = GoalTaskChange::parse(args)?;
        let plan_id = &change.plan_id;
        let home = self.directory.parent().ok_or(GoalError::Invalid)?;
        let index_path = self.directory.join("index.jsonl");
        if files::identity(&index_path)?.is_none() {
            return Err(missing);
        }
        let directory = log::directory(&self.directory)?;
        let lock = DirectoryLock::acquire(&index_path, Duration::from_millis(100), cancel)?;
        let index_before = files::identity(&index_path)?;
        let mut index = log::read(&index_path, cancel)?;
        let mut entries = index.iter_mut().filter(|row| row["planId"] == *plan_id);
        let entry = entries
            .next()
            .filter(|row| row["conversationId"] == publication.conversation)
            .ok_or(missing)?;
        if entries.next().is_some() {
            return Err(GoalError::Invalid);
        }
        let snapshot = self.read_bounded(plan_id, projector, cancel, 512 * 1024)?;
        let plan = self.read_context(plan_id, &snapshot.source_revision)?;
        if snapshot.facts["conversationId"] != publication.conversation
            || !super::plan_matches_workspace(&plan, publication.workspace)
        {
            return Err(missing);
        }
        let live_runner = publication
            .runner
            .is_some_and(|runner| runner.owns(&plan) && plan["runner"]["status"] == "running");
        if !plan["parentPlanId"].is_null()
            || !plan["delegationOrigin"].is_null()
            || snapshot.facts["runner"].is_object()
                && !live_runner
                && (snapshot.facts["runner"]["status"] != "idle"
                    || !super::explorer::retired(&plan["runner"]))
            || !matches!(
                snapshot.facts["status"].as_str(),
                Some("drafting" | "awaiting_approval" | "accepted" | "approved" | "executing")
            )
        {
            return Err(GoalError::Projection("goal_plan_requires_current_owner"));
        }
        let mut next = change.apply(plan.clone(), publication.at, |refs| {
            observed_evidence(home, publication.conversation, plan_id, refs, cancel)
        })?;
        if next == plan {
            admit().map_err(GoalError::Projection)?;
            let view =
                self.read_tool_view(publication.conversation, Some(plan_id), projector, cancel)?;
            if view["ok"] != true || self.revision(plan_id)? != snapshot.source_revision {
                return Err(GoalError::Changed);
            }
            lock.release()?;
            return Ok(
                json!({"ok":true,"planId":plan_id,"taskId":change.task_id,"plan":view["plan"]}),
            );
        }
        transition_plan(&mut next, publication.at)?;
        next["updatedAt"] = json!(publication.at);
        let facts = projector
            .execution_facts(&next, None)
            .map_err(GoalError::Projection)?;
        next["progress"] = facts["progress"].clone();
        entry["status"] = next["status"].clone();
        entry["updatedAt"] = next["updatedAt"].clone();
        entry["percent"] = next["progress"]["percent"].clone();
        let bytes = serde_json::to_vec(&next).map_err(|_| GoalError::Invalid)?;
        if bytes.len() > 512 * 1024 {
            return Err(GoalError::Limit);
        }
        let index = log::encode(&index)?;
        let journal = directory.join(".changes.jsonl");
        super::ordinary_create::notification_exists(&journal, None, cancel)?;
        let millis = timestamp(publication.at)?;
        let notification = log::encode(&[json!({"reason":"persist","changeKind":"persist",
            "planId":plan_id,"conversationId":publication.conversation,"revision":format!("{millis}-{}", publication.tool_call_id),
            "changedAt":publication.at,"writerPid":std::process::id()})])?;
        admit().map_err(GoalError::Projection)?;
        if files::identity(&index_path)? != index_before
            || self.revision(plan_id)? != snapshot.source_revision
        {
            return Err(GoalError::Changed);
        }
        lock.check_owned()?;
        log::replace(&directory.join(format!("{plan_id}.json")), &bytes, cancel)?;
        let uncertain = |_| GoalError::Store(StoreError::CommitUncertain);
        log::replace(&index_path, &index, None).map_err(uncertain)?;
        log::append_to_limit(&journal, &notification, u64::MAX, None).map_err(uncertain)?;
        let view = self
            .read_tool_view(publication.conversation, Some(plan_id), projector, None)
            .map_err(|_| GoalError::Store(StoreError::CommitUncertain))?;
        if view["ok"] != true {
            return Err(GoalError::Store(StoreError::CommitUncertain));
        }
        lock.release().map_err(uncertain)?;
        Ok(json!({"ok":true,"planId":plan_id,"taskId":change.task_id,"plan":view["plan"]}))
    }
}

fn supports_reference(
    message: &Value,
    segment: &Value,
    row: &Value,
    call: &str,
    reference: &str,
) -> Result<bool, GoalError> {
    if row["capabilityId"] == peer_protocol::WORKING_PLAN_CAPABILITY {
        return Ok(false);
    }
    let result = &segment["result"];
    if result.is_object() {
        if result["toolCallId"] != call
            || result["capabilityId"] != row["capabilityId"]
            || result["status"] != "success"
            || result["evidence"]["dispatchOutcome"] == "not_dispatched"
            || row["streamId"]
                .as_str()
                .is_some_and(|stream| message["streamId"] != stream)
            || !message["permissionGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|grant| grant["toolCallId"] == call && grant["granted"] == true)
        {
            return Ok(false);
        }
        return Ok(collect_tool_result_evidence_refs(Some(call), result)
            .map_err(|_| GoalError::Invalid)?
            .iter()
            .any(|value| value == reference));
    }
    // Old TUI transcripts keep a string preview beside the Host's completed
    // tool row. The preview alone does not establish a terminal observation.
    Ok(result.is_string()
        && segment["tool"] == row["capabilityId"]
        && message["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|tool| {
                tool["toolCallId"] == call
                    && tool["capabilityId"] == row["capabilityId"]
                    && tool["status"] == "completed"
            })
        && (reference.strip_prefix("tool-result://") == Some(call)
            || row["artifactRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|ref_value| ref_value == reference)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_working_plan_cannot_support_a_classic_goal_task() {
        use crate::{HostToolEvidence, NewConversation};

        let home = tempfile::tempdir().unwrap();
        let store = ConversationStore::new(home.path());
        let at = "2026-11-27T00:00:00Z";
        let created = store
            .create(
                &NewConversation {
                    title: "Classic goal",
                    workspace_path: None,
                    mode: "goal",
                    created_at: at,
                },
                None,
            )
            .unwrap();
        let conversation = created["id"].as_str().unwrap();
        let evidence = EvidenceIndexStore::new(home.path());

        for (call, tool, capability) in [
            (
                "plan-call",
                peer_protocol::WORKING_PLAN_TOOL_NAME,
                peer_protocol::WORKING_PLAN_CAPABILITY,
            ),
            ("read-call", "read_file", "local.file.read"),
        ] {
            let grant = json!({"grantId":format!("grant-{call}"), "toolCallId":call, "granted":true, "duration":"once", "decidedAt":at});
            let result = json!({"toolCallId":call, "capabilityId":capability, "status":"success", "completedAt":at,
                "outputPreview":{"kind":"json"}, "evidence":{"evidenceId":format!("evidence-{call}"),"toolCallId":call,"summary":tool,"artifactRefs":[]}});
            let message = json!({"id":format!("message-{call}"), "role":"assistant", "content":"", "streamId":"stream",
                "permissionGrants":[grant], "segments":[{"type":"tool-call", "toolCallId":call, "tool":tool, "result":result}]});
            let history = store
                .read_committed(conversation, None, log::MAX_BYTES)
                .unwrap();
            store.commit_message(&history, &message, at, None).unwrap();
            evidence
                .register(
                    &HostToolEvidence {
                        conversation_id: conversation,
                        plan_id: Some("plan"),
                        stream_id: Some("stream"),
                        tool_name: tool,
                        capability_id: capability,
                        tool_call_id: call,
                        grant: &grant,
                        result: &result,
                    },
                    None,
                )
                .unwrap();
        }

        let plan_ref = "tool-result://plan-call".to_owned();
        let read_ref = "tool-result://read-call".to_owned();
        assert_eq!(
            evidence
                .find(std::slice::from_ref(&plan_ref), None)
                .unwrap()
                .len(),
            1
        );
        assert!(
            observed_scoped_evidence(
                home.path(),
                conversation,
                "plan",
                std::slice::from_ref(&plan_ref),
                None,
                None
            )
            .unwrap()
            .is_empty()
        );
        assert_eq!(
            observed_scoped_evidence(
                home.path(),
                conversation,
                "plan",
                &[plan_ref, read_ref.clone()],
                None,
                None
            )
            .unwrap(),
            HashSet::from([read_ref]),
        );
    }

    #[test]
    fn validates_plan_approval_and_authoritative_evidence_before_changing_the_leaf() {
        let evidence = "tool-result://actual-file-read";
        let at = "2026-11-18T05:00:00.000Z";
        let change = GoalTaskChange::parse(&json!({
            "planId":"plan","taskId":"leaf","status":"completed","evidenceRefs":[evidence],
            "result":"Read the file.","criterionResults":[{"criterionId":"found","passed":true,"evidenceRef":evidence}]
        })).unwrap();
        assert_eq!(change.plan_id, "plan");
        let mut plan = json!({
            "planId":"plan","status":"awaiting_approval",
            "tasks":[{"taskId":"parent","subtasks":[{"taskId":"leaf","status":"pending","opaque":true}]}],
            "successCriteria":[{"id":"found","kind":"file-exists"}]
        });
        let available = |references: &[String]| {
            assert!(references.iter().all(|reference| reference == evidence));
            Ok(HashSet::from([evidence.to_owned()]))
        };
        assert_eq!(
            change.apply(plan.clone(), at, |_| panic!(
                "approval precedes evidence lookup"
            )),
            Err(GoalError::Projection("goal_plan_approval_required"))
        );
        plan["status"] = json!("approved");
        assert_eq!(
            change.apply(plan.clone(), at, |_| Ok(HashSet::new())),
            Err(GoalError::Projection(
                "goal_task_completion_requires_evidence"
            ))
        );
        let updated = change.apply(plan, at, available).unwrap();
        let leaf = &updated["tasks"][0]["subtasks"][0];
        assert_eq!(leaf["status"], "completed");
        assert_eq!(leaf["opaque"], true);
        assert_eq!(leaf["evidenceRefs"], json!([evidence]));
        assert_eq!(updated["criterionResults"][0]["evidenceRef"], evidence);
    }
}
