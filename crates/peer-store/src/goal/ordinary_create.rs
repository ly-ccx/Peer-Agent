//! Publishes an ordinary Goal through the same TS/native Goal write lock.
use super::*;
use crate::{DirectoryLock, durable_jsonl as log};
use peer_protocol::javascript_trim;
use serde_json::json;
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    time::Duration,
};

const MAX_DRAFT_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy)]
pub enum OrdinaryGoalKind {
    Chat,
    Plan,
    SelfDriven,
}

pub struct OrdinaryGoalDraft {
    title: String,
    goal: String,
    target: PathBuf,
    tasks: Vec<Value>,
    criteria: Vec<Value>,
}

fn text(value: &Value) -> Result<&str, GoalError> {
    value
        .as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty())
        .ok_or(GoalError::Invalid)
}

fn keys(value: &Value, allowed: &[&str]) -> Result<(), GoalError> {
    if value
        .as_object()
        .is_some_and(|row| row.keys().all(|key| allowed.contains(&key.as_str())))
    {
        Ok(())
    } else {
        Err(GoalError::Invalid)
    }
}

fn tasks(input: &Value) -> Result<Vec<Value>, GoalError> {
    let input = input
        .as_array()
        .filter(|rows| !rows.is_empty() && rows.len() <= 128)
        .ok_or(GoalError::Invalid)?;
    let mut plans = Vec::new();
    let mut ids = HashSet::new();
    for (i, value) in input.iter().enumerate() {
        keys(value, &["taskId", "title", "dependsOn"])?;
        let id = value
            .get("taskId")
            .map(text)
            .transpose()?
            .map(str::to_owned)
            .unwrap_or_else(|| format!("task-{}", i + 1));
        if id.len() > 200 || !ids.insert(id.clone()) {
            return Err(GoalError::Invalid);
        }
        let mut task = json!({"taskId":id,"title":text(&value["title"])?,"status":"pending"});
        if let Some(deps) = value.get("dependsOn") {
            let deps = deps
                .as_array()
                .filter(|deps| deps.len() <= 128)
                .ok_or(GoalError::Invalid)?;
            let normalized = deps.iter().map(text).collect::<Result<Vec<_>, _>>()?;
            if !normalized.is_empty() {
                task["dependsOn"] = json!(normalized);
            }
        }
        plans.push(task);
    }
    let mut resolved = HashSet::new();
    loop {
        let before = resolved.len();
        for task in &plans {
            if task["dependsOn"]
                .as_array()
                .into_iter()
                .flatten()
                .all(|id| resolved.contains(id.as_str().unwrap_or("")))
            {
                resolved.insert(task["taskId"].as_str().unwrap_or(""));
            }
        }
        if resolved.len() == plans.len() {
            return Ok(plans);
        }
        if resolved.len() == before {
            return Err(GoalError::Projection("goal_task_dependencies_invalid"));
        }
    }
}

fn criteria(input: Option<&Value>) -> Result<Vec<Value>, GoalError> {
    let Some(input) = input else {
        return Ok(vec![]);
    };
    let rows = input
        .as_array()
        .filter(|rows| rows.len() <= 128)
        .ok_or(GoalError::Invalid)?;
    let mut output = Vec::new();
    let mut ids = HashSet::new();
    for (i, item) in rows.iter().enumerate() {
        if item.is_object() {
            keys(
                item,
                &["id", "kind", "description", "command", "path", "expect"],
            )?;
        }
        let id = item
            .get("id")
            .map(text)
            .transpose()?
            .map(str::to_owned)
            .unwrap_or_else(|| format!("c{}", i + 1));
        if id.len() > 200 || !ids.insert(id.clone()) {
            return Err(GoalError::Invalid);
        }
        let mut row = if item.is_string() {
            json!({"id":id,"kind":"manual","description":text(item)?})
        } else {
            let kind = text(&item["kind"])?;
            let required = match kind {
                "command" | "test" => &["command"][..],
                "file-contains" => &["path", "expect"][..],
                "file-exists" => &["path"][..],
                "manual" | "model_review" => &[][..],
                _ => return Err(GoalError::Invalid),
            };
            let description = item
                .get("description")
                .map(text)
                .transpose()?
                .or_else(|| item["command"].as_str().map(javascript_trim))
                .or_else(|| item["path"].as_str().map(javascript_trim))
                .filter(|text| !text.is_empty())
                .unwrap_or("(unnamed criterion)");
            let mut row = json!({"id":id,"kind":kind,"description":description});
            for key in required {
                row[*key] = json!(text(&item[*key])?);
            }
            row
        };
        if let Some(description) = item.get("description") {
            row["description"] = json!(text(description)?);
        }
        output.push(row);
    }
    Ok(output)
}

impl OrdinaryGoalDraft {
    pub fn parse(input: &Value, workspace: &Path) -> Result<Self, GoalError> {
        keys(
            input,
            &[
                "title",
                "goal",
                "targetWorkspacePath",
                "tasks",
                "successCriteria",
                "parentPlanId",
                "sourceTaskId",
            ],
        )?;
        if input.get("parentPlanId").is_some() || input.get("sourceTaskId").is_some() {
            return Err(GoalError::Projection("goal_derived_creation_unavailable"));
        }
        if serde_json::to_vec(input)
            .map_err(|_| GoalError::Invalid)?
            .len()
            > MAX_DRAFT_BYTES
        {
            return Err(GoalError::Limit);
        }
        let target = input
            .get("targetWorkspacePath")
            .map(text)
            .transpose()?
            .map(Path::new)
            .unwrap_or(workspace);
        if !target.is_absolute() {
            return Err(GoalError::Invalid);
        }
        Ok(Self {
            title: text(&input["title"])?.into(),
            goal: text(&input["goal"])?.into(),
            target: target.into(),
            tasks: tasks(&input["tasks"])?,
            criteria: criteria(input.get("successCriteria"))?,
        })
    }

    fn body(&self, request: &GoalPublication<'_>) -> Value {
        let self_driven = matches!(request.kind, OrdinaryGoalKind::SelfDriven);
        let status = if matches!(request.kind, OrdinaryGoalKind::Plan) {
            "awaiting_approval"
        } else {
            "accepted"
        };
        let activation = if self_driven {
            json!({"kind":"accepted_goal","acceptedAt":request.at,"acceptedBy":"user"})
        } else {
            json!({"kind":"approval_required"})
        };
        json!({
            "planId":request.plan_id,"conversationId":request.conversation,
            "originWorkspacePath":request.workspace,"targetWorkspacePath":self.target,
            "title":self.title,"goal":self.goal,"tasks":self.tasks,"successCriteria":self.criteria,
            "status":status,"workflowKind":if self_driven {"goal_self_driven"} else {"plan_approval"},
            "activation":activation,
            "executionPolicy":{"autonomy":if self_driven {"self_driven"} else {"approval_gated"},
                "irreversibleRequiresConfirmation":true,"writeScope":"workspace_and_boundaries",
                "askUserOn":["ambiguous_goal","product_decision","high_risk","irreversible","missing_permission","missing_credentials","verification_conflict","scope_drift"]},
            "version":1,"createdAt":request.at,"updatedAt":request.at,"createdBy":"agent",
            "criterionResults":[],"manualConfirmations":[],"boundaries":{"inScope":[],"outOfScope":[]},
            "exceptionPolicies":[],"involvedFiles":[],"revisionHistory":[],"evidenceRefs":[],
            "progress":{"total":self.tasks.len(),"completed":0,"failed":0,"blocked":0,"percent":0}
        })
    }
}

pub struct GoalPublication<'a> {
    pub plan_id: &'a str,
    pub conversation: &'a str,
    pub workspace: &'a Path,
    pub kind: OrdinaryGoalKind,
    pub at: &'a str,
}

fn same_draft(left: &Value, right: &Value) -> bool {
    !left["runner"].is_object()
        && left["delegationOrigin"].is_null()
        && left["approval"].is_null()
        && [
            "conversationId",
            "originWorkspacePath",
            "targetWorkspacePath",
            "title",
            "goal",
            "tasks",
            "successCriteria",
            "status",
            "workflowKind",
        ]
        .into_iter()
        .all(|key| left[key] == right[key])
}

fn receipt(plan: Value) -> Value {
    json!({"ok":true,"planId":plan["planId"],"status":plan["status"],"workflowKind":plan["workflowKind"],
        "taskCount":plan["tasks"].as_array().map_or(0, Vec::len),"plan":plan})
}

fn uncertain(_: StoreError) -> GoalError {
    GoalError::Store(StoreError::CommitUncertain)
}

pub(super) fn notification_exists(
    path: &Path,
    repairing: Option<(&str, &str)>,
    cancel: Option<&AtomicBool>,
) -> Result<bool, StoreError> {
    let Some((mut file, identity)) = files::open(path, u64::MAX)? else {
        return Ok(false);
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|_| StoreError::ReadFailed)?.nlink() != 1 {
            return Err(StoreError::ReadFailed);
        }
    }
    if identity.size == 0 {
        return Ok(false);
    }
    let mut byte = [0];
    file.seek(SeekFrom::End(-1))
        .and_then(|_| file.read_exact(&mut byte))
        .map_err(|_| StoreError::ReadFailed)?;
    if byte[0] != b'\n' {
        return Err(StoreError::HistoryCorrupt);
    }
    let Some((plan_id, conversation)) = repairing else {
        return Ok(false);
    };
    // The legacy watcher appends indefinitely. Only repair needs historical
    // deduplication, and it must prove absence before appending again.
    if identity.size > 64 * 1024 * 1024 {
        return Err(StoreError::HistoryLimit);
    }
    file.rewind().map_err(|_| StoreError::ReadFailed)?;
    let mut reader = BufReader::new(file.take(identity.size));
    let mut line = Vec::new();
    let mut found = false;
    loop {
        log::check_cancel(cancel)?;
        line.clear();
        let read = (&mut reader)
            .take(256 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| StoreError::ReadFailed)?;
        if read == 0 {
            break;
        }
        if line.last() != Some(&b'\n') {
            return Err(StoreError::HistoryLimit);
        }
        let event: Value = serde_json::from_slice(&line).map_err(|_| StoreError::HistoryCorrupt)?;
        if event["reason"] == "persist"
            && event["planId"] == plan_id
            && event["conversationId"] == conversation
        {
            found = true;
            break;
        }
    }
    if files::identity(path)?.as_ref() != Some(&identity) {
        return Err(StoreError::VersionChanged);
    }
    Ok(found)
}

impl GoalStore {
    pub fn publish_ordinary_goal(
        &self,
        draft: &OrdinaryGoalDraft,
        request: GoalPublication<'_>,
        projector: &impl GoalFactProjector,
        cancel: Option<&AtomicBool>,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Value, GoalError> {
        if !valid_id(request.plan_id, false) || !valid_id(request.conversation, false) {
            return Err(GoalError::Invalid);
        }
        let at =
            time::OffsetDateTime::parse(request.at, &time::format_description::well_known::Rfc3339)
                .map_err(|_| GoalError::Invalid)?;
        let expected = draft.body(&request);
        let directory = log::directory(&self.directory)?;
        let index_path = directory.join("index.jsonl");
        let lock = DirectoryLock::acquire(&index_path, Duration::from_millis(100), cancel)?;
        let index_before = files::identity(&index_path)?;
        let mut index = log::read(&index_path, cancel)?;
        let mut ids = HashSet::new();
        let mut revisions = Vec::new();
        let mut active = None;
        for row in &index {
            let id = row["planId"]
                .as_str()
                .filter(|id| valid_id(id, false))
                .ok_or(GoalError::Invalid)?;
            if !ids.insert(id.to_owned()) {
                return Err(GoalError::Invalid);
            }
            if row["conversationId"] != request.conversation {
                if id == request.plan_id {
                    return Err(GoalError::Changed);
                }
                continue;
            }
            let snapshot = self.read_bounded(id, projector, cancel, 512 * 1024)?;
            if snapshot.facts["conversationId"] != request.conversation {
                return Err(GoalError::Changed);
            }
            if snapshot.facts["active"] == true {
                let raw = self.read_context(id, &snapshot.source_revision)?;
                if active.is_some()
                    || !same_draft(&raw, &expected)
                    || snapshot.facts["runner"].is_object()
                {
                    return Err(GoalError::Projection("goal_active_requires_reconciliation"));
                }
                active = Some(id.to_owned());
            }
            revisions.push((id.to_owned(), snapshot.source_revision));
        }

        let plan_path = directory.join(format!("{}.json", request.plan_id));
        let body_before = files::identity(&plan_path)?;
        let raw = if body_before.is_some() {
            let existing = self.read_context(request.plan_id, &self.revision(request.plan_id)?)?;
            if !same_draft(&existing, &expected) {
                return Err(GoalError::Changed);
            }
            existing
        } else {
            expected
        };
        let own_index = ids.contains(request.plan_id);
        if !own_index {
            let mut row = serde_json::Map::new();
            for key in [
                "planId",
                "title",
                "status",
                "workflowKind",
                "conversationId",
                "originWorkspacePath",
                "targetWorkspacePath",
                "version",
                "createdAt",
                "updatedAt",
            ] {
                row.insert(key.into(), raw[key].clone());
            }
            row.insert("percent".into(), json!(0));
            index.push(Value::Object(row));
        }
        let index_bytes = log::encode(&index)?;
        let bytes = serde_json::to_vec(&raw).map_err(|_| GoalError::Invalid)?;
        let changes = directory.join(".changes.jsonl");
        let repeated = active.as_deref().filter(|id| *id != request.plan_id);
        let already_notified = repeated.is_none()
            && notification_exists(
                &changes,
                body_before
                    .is_some()
                    .then_some((request.plan_id, request.conversation)),
                cancel,
            )?;
        let fingerprint = format!(
            "{}-{}",
            at.unix_timestamp_nanos() / 1_000_000,
            request.plan_id
        );
        let event = log::encode(&[json!({"reason":"persist","planId":request.plan_id,
            "conversationId":request.conversation,"revision":fingerprint,"writerPid":std::process::id(),
            "changedAt":request.at,"changeKind":if matches!(request.kind, OrdinaryGoalKind::SelfDriven) {"goal-accepted"} else {"persist"}
        })])?;
        if files::identity(&index_path)? != index_before
            || files::identity(&plan_path)? != body_before
        {
            return Err(GoalError::Changed);
        }
        for (id, revision) in revisions {
            if self.revision(&id)? != revision {
                return Err(GoalError::Changed);
            }
        }
        admit().map_err(GoalError::Projection)?;
        log::check_cancel(cancel)?;
        lock.check_owned()?;
        if let Some(id) = repeated {
            if body_before.is_some() {
                return Err(GoalError::Changed);
            }
            // A repeat from another Tool Call refers to the original Goal.
            let value = self.read_tool_view(request.conversation, Some(id), projector, cancel)?;
            if value["ok"] != true {
                return Err(GoalError::Changed);
            }
            lock.release()?;
            return Ok(receipt(value["plan"].clone()));
        }
        if body_before.is_none() {
            log::replace(&plan_path, &bytes, cancel)?;
        }
        // Once the body may exist, complete and report the actual publication.
        if !own_index {
            log::replace(&index_path, &index_bytes, None).map_err(uncertain)?;
        }
        if !already_notified {
            log::append_to_limit(&changes, &event, u64::MAX, None).map_err(uncertain)?;
        }
        let value = self
            .read_tool_view(request.conversation, Some(request.plan_id), projector, None)
            .map_err(|_| GoalError::Store(StoreError::CommitUncertain))?;
        if value["ok"] != true {
            return Err(GoalError::Store(StoreError::CommitUncertain));
        }
        lock.release().map_err(uncertain)?;
        Ok(receipt(value["plan"].clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ScopedPlanFacts;
    impl GoalFactProjector for ScopedPlanFacts {
        fn execution_facts(&self, body: &Value, _: Option<&Value>) -> Result<Value, &'static str> {
            let mut facts = body.clone();
            facts["active"] = json!(true);
            Ok(facts)
        }
    }

    #[test]
    fn same_goal_publication_repairs_partial_index_without_rewriting_canonical_body() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path();
        let store = GoalStore::new(root.path());
        let draft = OrdinaryGoalDraft::parse(
            &json!({"title":"Fixture plan","goal":"Test real writes","tasks":[{"title":"Check"}]}),
            workspace,
        )
        .unwrap();
        let index = root.path().join("goal-plans/index.jsonl");
        let body = root.path().join("goal-plans/owned-plan.json");
        let changes = root.path().join("goal-plans/.changes.jsonl");
        std::fs::create_dir(changes.parent().unwrap()).unwrap();
        let previous_events = "{\"reason\":\"persist\",\"planId\":\"historical\"}\n".repeat(4097);
        std::fs::write(&changes, &previous_events).unwrap();
        let request = |at| GoalPublication {
            plan_id: "owned-plan",
            conversation: "owned-conversation",
            workspace,
            kind: OrdinaryGoalKind::Plan,
            at,
        };
        let result = store.publish_ordinary_goal(
            &draft,
            request("2026-11-18T01:00:00Z"),
            &ScopedPlanFacts,
            None,
            || {
                std::fs::create_dir(&index).unwrap();
                Ok(())
            },
        );
        assert_eq!(
            result.unwrap_err(),
            GoalError::Store(StoreError::CommitUncertain)
        );
        let original = std::fs::read(&body).unwrap();
        assert!(index.is_dir());
        std::fs::remove_dir(&index).unwrap();
        assert_eq!(
            store
                .read_tool_view(
                    "owned-conversation",
                    Some("owned-plan"),
                    &ScopedPlanFacts,
                    None
                )
                .unwrap()["ok"],
            false
        );
        let result = store
            .publish_ordinary_goal(
                &draft,
                request("2026-11-18T02:00:00Z"),
                &ScopedPlanFacts,
                None,
                || Ok(()),
            )
            .unwrap();
        assert_eq!(result["status"], "awaiting_approval");
        assert_eq!(std::fs::read(&body).unwrap(), original);
        assert_eq!(log::read(&index, None).unwrap().len(), 1);
        let events = std::fs::read_to_string(&changes).unwrap();
        assert!(events.starts_with(&previous_events));
        assert_eq!(events.lines().count(), 4098);
        store
            .publish_ordinary_goal(
                &draft,
                request("2026-11-18T03:00:00Z"),
                &ScopedPlanFacts,
                None,
                || Ok(()),
            )
            .unwrap();
        assert_eq!(std::fs::read_to_string(&changes).unwrap(), events);
    }
}
