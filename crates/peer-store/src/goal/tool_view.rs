//! Read-only model projection of the canonical local Goal store.
use super::*;
use serde_json::{Map, json};
use std::collections::HashSet;

const VIEW_BYTES: usize = 512 * 1024;
const PLAN_FIELDS: &[&str] = &[
    "conversationId",
    "threadId",
    "title",
    "goal",
    "workflowKind",
    "activation",
    "approval",
    "executionPolicy",
    "version",
    "createdAt",
    "originWorkspacePath",
    "targetWorkspacePath",
    "parentPlanId",
    "sourceTaskId",
    "rootPlanId",
    "successCriteria",
    "criterionResults",
    "manualConfirmations",
    "qualityReview",
    "boundaries",
    "exceptionPolicies",
    "involvedFiles",
    "resultAcceptance",
    "resultAcceptedAt",
    "resultAcceptedBy",
];
const INDEX_FIELDS: &[&str] = &[
    "planId",
    "conversationId",
    "threadId",
    "title",
    "workflowKind",
    "version",
    "createdAt",
    "originWorkspacePath",
    "targetWorkspacePath",
    "targetRepoId",
    "targetBranch",
    "targetBranchSource",
    "resultAcceptance",
    "resultAcceptedAt",
    "resultAcceptedBy",
    "deliveryHandoff",
];
const TASK_FIELDS: &[&str] = &[
    "taskId",
    "title",
    "description",
    "status",
    "dependsOn",
    "result",
    "failureReason",
    "blockedReason",
    "evidenceRefs",
    "acceptanceCriteria",
    "completedAt",
];

fn fields(value: &Value, names: &[&str]) -> Map<String, Value> {
    names
        .iter()
        .filter_map(|&key| value.get(key).map(|value| (key.to_owned(), value.clone())))
        .collect()
}

fn tasks(value: &Value) -> Result<Value, GoalError> {
    if value.is_null() {
        return Ok(json!([]));
    }
    let mut out = Vec::new();
    for task in value.as_array().ok_or(GoalError::Invalid)? {
        let id = task["taskId"].as_str().ok_or(GoalError::Invalid)?;
        if id.is_empty() {
            return Err(GoalError::Invalid);
        }
        let mut row = fields(task, TASK_FIELDS);
        if let Some(children) = task.get("subtasks") {
            row.insert("subtasks".into(), tasks(children)?);
        }
        out.push(Value::Object(row));
    }
    Ok(Value::Array(out))
}

fn detail(id: &str, body: &Value, facts: &Value) -> Result<Value, GoalError> {
    // Preserve identities near the front of the preview for archived results.
    let mut model = Map::new();
    model.insert("planId".into(), json!(id));
    model.insert("tasks".into(), tasks(&body["tasks"])?);
    model.insert("status".into(), facts["status"].clone());
    model.extend(fields(body, PLAN_FIELDS));
    model.insert("updatedAt".into(), facts["updatedAt"].clone());
    model.insert("progress".into(), facts["progress"].clone());
    if facts["runner"].is_object() {
        let mut runner = facts["runner"].clone();
        if let Some(object) = runner.as_object_mut() {
            object.remove("verificationContinuation");
        }
        model.insert("runner".into(), runner);
    }
    Ok(json!({"ok":true,"plan":model}))
}

impl GoalStore {
    pub fn read_tool_view(
        &self,
        conversation: &str,
        plan_id: Option<&str>,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, GoalError> {
        if !valid_id(conversation, false) || plan_id.is_some_and(|id| !valid_id(id, false)) {
            return Err(GoalError::Invalid);
        }
        let index = self.directory.join("index.jsonl");
        let index_before = files::identity(&index)?;
        let rows = crate::durable_jsonl::read(&index, cancel)?;
        let mut ids = HashSet::new();
        let mut source_bytes = 0_u64;
        let mut revisions = Vec::new();
        let mut listed = Vec::new();
        let mut selected = None;
        for row in rows {
            let id = row["planId"]
                .as_str()
                .filter(|id| valid_id(id, false))
                .ok_or(GoalError::Invalid)?;
            if !ids.insert(id.to_owned()) {
                return Err(GoalError::Invalid);
            }
            if row["conversationId"] != conversation
                || plan_id.is_some_and(|requested| requested != id)
            {
                continue;
            }
            let observed = self.read_bounded(id, projector, cancel, VIEW_BYTES as u64)?;
            source_bytes = source_bytes.saturating_add(observed.source_bytes);
            if source_bytes > crate::durable_jsonl::MAX_BYTES as u64 {
                return Err(GoalError::Limit);
            }
            if observed.facts["conversationId"] != conversation {
                if plan_id.is_some() {
                    continue;
                }
                return Err(GoalError::Invalid);
            }
            if plan_id.is_some() {
                let body = self.read_context(id, &observed.source_revision)?;
                selected = Some(detail(id, &body, &observed.facts)?);
            } else if observed.facts["status"] != "cancelled" {
                let mut summary = fields(&row, INDEX_FIELDS);
                summary.insert("status".into(), observed.facts["status"].clone());
                summary.insert("updatedAt".into(), observed.facts["updatedAt"].clone());
                summary.insert(
                    "percent".into(),
                    observed.facts["progress"]["percent"].clone(),
                );
                listed.push(Value::Object(summary));
            }
            revisions.push((id.to_owned(), observed.source_revision));
        }
        if files::identity(&index)? != index_before {
            return Err(GoalError::Changed);
        }
        for (id, revision) in revisions {
            if self.revision(&id)? != revision {
                return Err(GoalError::Changed);
            }
        }
        crate::durable_jsonl::check_cancel(cancel)?;
        let out = if plan_id.is_some() {
            selected.unwrap_or_else(|| json!({"ok":false,"plan":null}))
        } else {
            listed.sort_by(|left, right| {
                right["updatedAt"].as_str().cmp(&left["updatedAt"].as_str())
            });
            json!({"ok":true,"plans":listed})
        };
        if serde_json::to_vec(&out)
            .map_err(|_| GoalError::Invalid)?
            .len()
            > VIEW_BYTES
        {
            return Err(GoalError::Limit);
        }
        Ok(out)
    }
}
