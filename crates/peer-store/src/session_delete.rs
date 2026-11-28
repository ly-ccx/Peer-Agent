//! Explicit management deletion holds the existing writer fences while
//! completing the two independent Store lifecycles.
mod locks;

use crate::{
    ConversationStore, StoreError, conversation_execution, durable_jsonl as log, files,
    goal_source, valid_id,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const MAX_INTENT_BYTES: usize = 1024 * 1024;
const MAX_CHANGE_BYTES: u64 = 256 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    version: u8,
    conversation: String,
    tickets: [locks::Ticket; 3],
    selection: Option<Selection>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    plans: BTreeSet<String>,
    recorded_at: String,
    revision: String,
    change_offset: u64,
}

struct Stores {
    conversations: PathBuf,
    goals: PathBuf,
}

impl Stores {
    fn resolve(home: &Path) -> Result<Self, StoreError> {
        Ok(Self {
            conversations: existing_directory(&home.join("conversations"))?,
            goals: log::directory(&home.join("goal-plans"))?,
        })
    }

    fn files(&self, id: &str) -> [PathBuf; 3] {
        [
            self.conversations.join("index.jsonl"),
            self.conversations.join(format!("{id}.jsonl")),
            self.goals.join("index.jsonl"),
        ]
    }
}

fn existing_directory(path: &Path) -> Result<PathBuf, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::canonicalize(path).map_err(|_| StoreError::ReadFailed),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StoreError::NotFound),
        _ => Err(StoreError::ReadFailed),
    }
}

fn intent_file(directory: &Path, id: &str) -> Result<PathBuf, StoreError> {
    if !valid_id(id, false) {
        return Err(StoreError::InvalidInput);
    }
    Ok(directory.join(format!(".delete-{id}.json")))
}

fn read_intent(path: &Path, id: &str) -> Result<Option<Intent>, StoreError> {
    let Some(bytes) = files::read(path, MAX_INTENT_BYTES)? else {
        return Ok(None);
    };
    let intent: Intent = serde_json::from_slice(&bytes).map_err(|_| StoreError::HistoryCorrupt)?;
    if intent.version != 1
        || intent.conversation != id
        || intent.selection.as_ref().is_some_and(|selected| {
            selected.plans.len() > 4096
                || selected.plans.iter().any(|id| !valid_id(id, false))
                || uuid::Uuid::parse_str(&selected.revision).is_err()
                || !crate::conversation_write::timestamp(&selected.recorded_at)
        })
    {
        return Err(StoreError::HistoryCorrupt);
    }
    Ok(Some(intent))
}

fn persist_intent(path: &Path, intent: &Intent) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(intent).map_err(|_| StoreError::HistoryCorrupt)?;
    if bytes.len() > MAX_INTENT_BYTES {
        return Err(StoreError::HistoryLimit);
    }
    log::replace(path, &bytes, None)
}

pub fn session_delete_exists(home: &Path, id: &str) -> Result<bool, StoreError> {
    let path = intent_file(&home.join("conversations"), id)?;
    if read_intent(&path, id)?.is_some() {
        return Ok(true);
    }
    match ConversationStore::new(home).read_metadata(id) {
        Ok(source) => Ok(source.metadata.is_some()),
        Err(StoreError::NotFound) => Ok(false),
        Err(error) => Err(error),
    }
}

pub fn delete_session(home: &Path, id: &str) -> Result<(), StoreError> {
    if !session_delete_exists(home, id)? {
        return Err(StoreError::NotFound);
    }
    let stores = Stores::resolve(home)?;
    let owner = locks::lock_directory(&stores.conversations)?;
    let path = intent_file(&stores.conversations, id)?;
    let files = stores.files(id);
    locks::check_directory(&owner, &stores.conversations)?;
    let mut intent = if let Some(intent) = read_intent(&path, id)? {
        intent
    } else {
        if ConversationStore::new(home)
            .read_metadata(id)?
            .metadata
            .is_none()
        {
            return Err(StoreError::NotFound);
        }
        let intent = Intent {
            version: 1,
            conversation: id.to_owned(),
            tickets: [
                locks::Ticket::prepare(&files[0])?,
                locks::Ticket::prepare(&files[1])?,
                locks::Ticket::prepare(&files[2])?,
            ],
            selection: None,
        };
        persist_intent(&path, &intent)?;
        intent
    };
    let conversation_index = intent.tickets[0].acquire(&files[0])?;
    let conversation_body = intent.tickets[1].acquire(&files[1])?;
    #[cfg(feature = "test-fixtures")]
    fault(home, "after_history_lock");
    let mut held = [
        conversation_index,
        conversation_body,
        intent.tickets[2].acquire(&files[2])?,
    ];
    #[cfg(feature = "test-fixtures")]
    fault(home, "after_locks");
    let mut conversations = log::read(&files[0], None)?;
    let mut goals = log::read(&files[2], None)?;
    let mut target = conversations.iter().filter(|row| row["id"] == id);
    match target.next() {
        Some(meta) => check_conversation(&stores, id, meta)?,
        None if intent.selection.is_none() => return Err(StoreError::NotFound),
        None => (),
    }
    if target.next().is_some() {
        return Err(StoreError::HistoryCorrupt);
    }
    let plans = owned_plans(&goals, id)?;
    let changes = stores.goals.join(".changes.jsonl");
    if let Some(selection) = &intent.selection {
        if !plans.is_subset(&selection.plans) {
            return Err(StoreError::GoalChanged);
        }
    } else {
        for plan in &plans {
            check_plan(&stores.goals, plan, id, true)?;
        }
        let change_offset = if plans.is_empty() {
            0
        } else {
            change_end(&changes)?
        };
        intent.selection = Some(Selection {
            plans,
            recorded_at: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .map_err(|_| StoreError::InvalidInput)?,
            revision: uuid::Uuid::new_v4().to_string(),
            change_offset,
        });
        persist_intent(&path, &intent)?;
    }
    let selected = intent
        .selection
        .as_ref()
        .expect("persisted delete selection");
    for row in &goals {
        if row["planId"]
            .as_str()
            .is_some_and(|plan| selected.plans.contains(plan))
            && row["conversationId"] != id
        {
            return Err(StoreError::GoalChanged);
        }
    }
    for plan in &selected.plans {
        check_plan(&stores.goals, plan, id, false)?;
    }
    for lock in &held {
        lock.check()?;
    }
    if !selected.plans.is_empty() {
        change_end(&changes)?;
    }
    locks::check_directory(&owner, &stores.conversations)?;
    // Check all destination shapes before the first index publication.
    let mut remove = vec![
        files[1].clone(),
        stores.conversations.join(format!("{id}.stream.json")),
    ];
    if let Some(directory) = optional_directory(&stores.conversations.join(".context-snapshots"))? {
        remove.push(directory.join(format!("{id}.json")));
    }
    if let Some(directory) = optional_directory(&stores.conversations.join(".working-plans"))? {
        remove.push(directory.join(format!("{id}.json")));
    }
    let progress = optional_directory(&stores.goals.join("runner-progress"))?;
    for plan in &selected.plans {
        remove.push(stores.goals.join(format!("{plan}.json")));
        if let Some(directory) = &progress {
            remove.push(directory.join(format!("{plan}.json")));
        }
    }
    for body in &remove {
        check_regular(body)?;
    }
    let before = conversations.len();
    conversations.retain(|row| row["id"] != id);
    let conversation_index = (conversations.len() != before)
        .then(|| log::encode(&conversations))
        .transpose()?;
    let before = goals.len();
    goals.retain(|row| row["conversationId"] != id);
    let goal_index = (goals.len() != before)
        .then(|| log::encode(&goals))
        .transpose()?;
    if let Some(index) = conversation_index {
        log::replace(&files[0], &index, None)?;
    }
    #[cfg(feature = "test-fixtures")]
    fault(home, "after_conversation");
    if let Some(index) = goal_index {
        log::replace(&files[2], &index, None)?;
    }
    #[cfg(feature = "test-fixtures")]
    fault(home, "after_goals");
    if !selected.plans.is_empty() {
        publish_change(&changes, id, selected)?;
    }
    #[cfg(feature = "test-fixtures")]
    fault(home, "after_notification");
    for body in &remove {
        remove_regular(body)?;
    }
    for lock in held.iter_mut().rev() {
        lock.release()?;
    }
    remove_regular(&path)?;
    for (ticket, file) in intent.tickets.iter().zip(files) {
        let _ = ticket.discard(&file);
    }
    Ok(())
}

fn owned_plans(rows: &[Value], id: &str) -> Result<BTreeSet<String>, StoreError> {
    let mut selected = BTreeSet::new();
    for row in rows.iter().filter(|row| row["conversationId"] == id) {
        let plan = row["planId"]
            .as_str()
            .filter(|plan| valid_id(plan, false))
            .ok_or(StoreError::GoalCorrupt)?;
        if !selected.insert(plan.to_owned()) {
            return Err(StoreError::GoalCorrupt);
        }
    }
    Ok(selected)
}

fn check_conversation(stores: &Stores, id: &str, meta: &Value) -> Result<(), StoreError> {
    if files::identity(&stores.conversations.join(format!("{id}.stream.json")))?.is_some() {
        return Err(StoreError::StreamStateInvalid);
    }
    if let Some(run) = conversation_execution::decode(meta, id)?
        && (!run.permits_new_run()
            || !run.handles.is_empty()
            || !run.stop.as_ref().is_some_and(|stop| {
                stop.runner_idle && stop.admission_closed && stop.handles_ended
            }))
    {
        return Err(StoreError::ExecutionBusy);
    }
    check_history_settled(&stores.conversations.join(format!("{id}.jsonl")))
}

fn check_history_settled(path: &Path) -> Result<(), StoreError> {
    let Some((file, prior)) = files::open(path, u64::MAX)? else {
        return Ok(());
    };
    let mut reader = BufReader::new(file.take(prior.size));
    let mut line = Vec::new();
    loop {
        line.clear();
        if (&mut reader)
            .take(log::MAX_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| StoreError::ReadFailed)?
            == 0
        {
            break;
        }
        if line.len() > log::MAX_BYTES {
            return Err(StoreError::HistoryLimit);
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let message: Value =
            serde_json::from_slice(&line).map_err(|_| StoreError::HistoryCorrupt)?;
        let unresolved_segment = message["segments"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|segment| segment["type"] == "tool-call" && unresolved_result(&segment["result"]));
        let unresolved_legacy = message["kind"] == "agent_turn"
            && message["rounds"]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|round| round["toolCalls"].as_array().into_iter().flatten())
                .any(|call| {
                    let result = &call["result"];
                    // Legacy agent-turn receipts may serialize this object as text.
                    if let Some(text) = result.as_str()
                        && let Ok(decoded) = serde_json::from_str::<Value>(text)
                        && decoded.is_object()
                    {
                        return unresolved_result(&decoded);
                    }
                    unresolved_result(result)
                });
        if unresolved_segment || unresolved_legacy {
            return Err(StoreError::ExecutionBusy);
        }
    }
    if files::identity(path)?.as_ref() != Some(&prior) {
        return Err(StoreError::VersionChanged);
    }
    Ok(())
}

fn unknown_outcome(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("execution_outcome_unknown" | "cancelled_outcome_unknown" | "outcome_unknown")
    )
}

fn unresolved_result(result: &Value) -> bool {
    result.is_null()
        || matches!(
            result["status"].as_str(),
            Some("pending" | "running" | "streaming")
        )
        || unknown_outcome(&result["error"])
        || unknown_outcome(&result["error"]["code"])
        || unknown_outcome(&result["evidence"]["dispatchOutcome"])
}

fn check_plan(directory: &Path, id: &str, owner: &str, required: bool) -> Result<(), StoreError> {
    let path = directory.join(format!("{id}.json"));
    let Some(plan) = goal_source::deletion_plan(&path, 1024 * 1024 * 1024)? else {
        return if required {
            Err(StoreError::GoalChanged)
        } else {
            Ok(())
        };
    };
    if plan["planId"] != id || plan["conversationId"] != owner {
        return Err(StoreError::GoalChanged);
    }
    if plan_busy(&plan["runner"]) {
        return Err(StoreError::ExecutionBusy);
    }
    if let Some(dir) = optional_directory(&directory.join("runner-progress"))?
        && let Some(progress) =
            goal_source::deletion_plan(&dir.join(format!("{id}.json")), 4 * 1024 * 1024)?
    {
        if progress["planId"] != id {
            return Err(StoreError::GoalChanged);
        }
        if plan_busy(&progress["runner"]) {
            return Err(StoreError::ExecutionBusy);
        }
    }
    Ok(())
}

fn plan_busy(runner: &Value) -> bool {
    matches!(runner["status"].as_str(), Some("running" | "verifying"))
        || runner["nativeVerifierId"].is_string()
        || unknown_outcome(&runner["blockedReason"])
        || runner["explorers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row["status"] == "running")
}

fn optional_directory(path: &Path) -> Result<Option<PathBuf>, StoreError> {
    match existing_directory(path) {
        Ok(path) => Ok(Some(path)),
        Err(StoreError::NotFound) => Ok(None),
        Err(error) => Err(error),
    }
}

fn check_regular(path: &Path) -> Result<bool, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        _ => Err(StoreError::ReadFailed),
    }
}

fn remove_regular(path: &Path) -> Result<(), StoreError> {
    if check_regular(path)? {
        fs::remove_file(path).map_err(|_| StoreError::ReadFailed)?;
        log::sync_dir(path.parent().ok_or(StoreError::InvalidInput)?)?;
    }
    Ok(())
}

fn change_end(path: &Path) -> Result<u64, StoreError> {
    let Some((mut file, prior)) = files::open(path, u64::MAX)? else {
        return Ok(0);
    };
    let meta = file.metadata().map_err(|_| StoreError::ReadFailed)?;
    if !crate::platform::metadata_nlink_is_one(&meta) {
        return Err(StoreError::ReadFailed);
    }
    if prior.size > 0 {
        file.seek(SeekFrom::End(-1))
            .map_err(|_| StoreError::ReadFailed)?;
        let mut last = [0];
        file.read_exact(&mut last)
            .map_err(|_| StoreError::ReadFailed)?;
        if last[0] != b'\n' {
            return Err(StoreError::HistoryCorrupt);
        }
    }
    Ok(prior.size)
}

fn publish_change(path: &Path, id: &str, selected: &Selection) -> Result<(), StoreError> {
    if let Some((mut file, prior)) = files::open(path, u64::MAX)? {
        if selected.change_offset > prior.size {
            return Err(StoreError::VersionChanged);
        }
        file.seek(SeekFrom::Start(selected.change_offset))
            .map_err(|_| StoreError::ReadFailed)?;
        let mut reader = BufReader::new(file.take(prior.size - selected.change_offset));
        let mut line = Vec::new();
        loop {
            line.clear();
            if (&mut reader)
                .take(MAX_CHANGE_BYTES + 1)
                .read_until(b'\n', &mut line)
                .map_err(|_| StoreError::ReadFailed)?
                == 0
            {
                break;
            }
            if line.last() != Some(&b'\n') || line.len() as u64 > MAX_CHANGE_BYTES {
                return Err(StoreError::HistoryCorrupt);
            }
            let event: Value =
                serde_json::from_slice(&line).map_err(|_| StoreError::HistoryCorrupt)?;
            if event["revision"] == selected.revision {
                if event["reason"] != "delete"
                    || event["conversationId"] != id
                    || files::identity(path)?.as_ref() != Some(&prior)
                {
                    return Err(StoreError::VersionChanged);
                }
                #[cfg(unix)]
                reader
                    .get_ref()
                    .get_ref()
                    .sync_all()
                    .map_err(|_| StoreError::CommitUncertain)?;
                return log::sync_dir(path.parent().ok_or(StoreError::InvalidInput)?);
            }
        }
        if files::identity(path)?.as_ref() != Some(&prior) {
            return Err(StoreError::VersionChanged);
        }
    } else if selected.change_offset != 0 {
        return Err(StoreError::VersionChanged);
    }
    let event = json!({"reason":"delete","changeKind":"delete","planId":null,"conversationId":id,
        "revision":selected.revision,"changedAt":selected.recorded_at,"writerPid":std::process::id()});
    log::append_to_limit(path, &log::encode(&[event])?, u64::MAX, None)
}

#[cfg(feature = "test-fixtures")]
fn fault(home: &Path, stage: &str) {
    if home.join(".native-cli-fixture").is_file()
        && std::env::var("PEER_NATIVE_DELETE_FAULT").as_deref() == Ok(stage)
    {
        std::process::exit(88);
    }
}
