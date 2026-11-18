use super::*;
use crate::{ConversationStore, GoalSourceStore, GoalStore};
use peer_protocol::interactive_result::{
    INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_SUMMARY_UNITS,
    interactive_token,
};
use serde_json::json;
use std::io::{Read as _, Seek as _, SeekFrom};

// Same cold EvidenceIndex search window as the existing GoalPlan Store.
const EVIDENCE_TAIL_BYTES: u64 = 16 * 1024 * 1024;

pub(super) fn read_portable(
    home: &Path,
    reference: &InteractiveResultReference,
) -> Option<InteractiveResultSummary> {
    let locator = reference.locator();
    let evidence_path = home.join("goal-plans/evidence-index.jsonl");
    let (record, evidence_before) = read_evidence_tail(&evidence_path, reference, &locator)?;
    let artifact = artifact(&record, reference, &locator)?;
    if record["evidenceRef"] != locator
        || record["capabilityId"] != INTERACTIVE_PUBLISH_CAPABILITY
        || record["toolName"] != INTERACTIVE_PUBLISH_TOOL
        || !included(&record["artifactRefs"], &locator)
    {
        return None;
    }
    let plan_id = token(&record, "planId")?;
    let conversation_id = token(&record, "conversationId")?;
    let tool_call_id = token(&record, "toolCallId")?;
    let snapshot = GoalSourceStore::new(home)
        .read_raw_fields(plan_id, 16 * 1024 * 1024, None)
        .ok()?;
    let plan = snapshot.raw_plan;
    let origin = &plan["delegationOrigin"];
    let session_id = token(origin, "sessionId")?;
    let owner = &reference.owner;
    if plan["conversationId"] != conversation_id
        || origin["workspaceId"] != owner.workspace_id
        || origin["parentConversationId"] != owner.conversation_id
        || conversation_id == owner.conversation_id
    {
        return None;
    }
    let conversations = ConversationStore::new(home);
    let history_sources = [
        home.join("conversations/index.jsonl"),
        home.join("conversations")
            .join(format!("{conversation_id}.jsonl")),
        home.join("conversations")
            .join(format!("{conversation_id}.stream.json")),
    ];
    if !crate::valid_id(conversation_id, false) {
        return None;
    }
    let before_history = versions(&history_sources)?;
    let parent = conversations.read_metadata(&owner.conversation_id).ok()?;
    let worker = conversations.read_metadata(conversation_id).ok()?;
    let parent_meta = parent.metadata?;
    let worker_meta = worker.metadata?;
    if parent.source_revision != worker.source_revision
        || parent_meta["role"] != "project_agent"
        || parent_meta["workspaceId"] != owner.workspace_id
        || worker_meta["role"] != "work_session"
        || worker_meta["workspaceId"] != owner.workspace_id
        || worker_meta["parentConversationId"] != owner.conversation_id
        || worker_meta["delegation"]["sessionId"] != session_id
    {
        return None;
    }
    let history = conversations
        .read_committed(conversation_id, None, 8 * 1024 * 1024)
        .ok()?;
    history.check_index(&history_sources[0]).ok()?;
    let (output, evidence_refs) = published(&history.history.messages, tool_call_id)?;
    let call = json!({"owner": owner, "conversationId":conversation_id, "toolCallId":tool_call_id});
    if output["kind"] != "interactive_publication"
        || output["publicationStatus"] != "published"
        || output["unchanged"] == true
        || output["callRef"] != call
        || !ref_equals(&output["reference"], reference)
        || output["artifactRef"] != locator
        || !included(&evidence_refs, &locator)
        || output["title"] != artifact["label"]
    {
        return None;
    }
    let title = artifact["label"].as_str()?;
    let text = output["textFallback"]
        .as_str()
        .filter(|s| s.len() <= FALLBACK_BYTES)?;
    let end = text
        .char_indices()
        .nth(INTERACTIVE_SUMMARY_UNITS)
        .map_or(text.len(), |(i, _)| i);
    if Some(evidence_before) != files::identity(&evidence_path).ok()?
        || GoalStore::new(home).revision(plan_id).ok()? != snapshot.source_revision
        || versions(&history_sources)? != before_history
    {
        return None;
    }
    let source = InteractiveResultSource {
        conversation_id: conversation_id.into(),
        plan_id: plan_id.into(),
        session_id: session_id.into(),
        tool_call_id: tool_call_id.into(),
        execution_epoch: None,
    };
    Some(summary(
        reference,
        InteractiveAvailability::OriginOnly,
        source,
        title.into(),
        text[..end].into(),
        end != text.len(),
    ))
}

fn token<'a>(record: &'a Value, key: &str) -> Option<&'a str> {
    record[key].as_str().filter(|id| interactive_token(id))
}

fn published(messages: &[Value], tool_call_id: &str) -> Option<(Value, Value)> {
    let mut found = None;
    for message in messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["interrupted"] != true)
    {
        let Some(segments) = message["segments"].as_array() else {
            continue;
        };
        for call in segments
            .iter()
            .filter(|c| c["type"] == "tool-call" && c["toolCallId"] == tool_call_id)
        {
            if found.is_some() || call["tool"] != INTERACTIVE_PUBLISH_TOOL {
                return None;
            }
            let raw = call["result"].as_str()?;
            let mut saved = decode(raw.as_bytes(), 128 * 1024)?;
            let output = if saved["kind"] == "local_capability_result_ref" {
                if saved["tool"] != INTERACTIVE_PUBLISH_TOOL
                    || saved["capabilityId"] != INTERACTIVE_PUBLISH_CAPABILITY
                    || saved["status"] != "success"
                    || !call["endedAtMs"].as_f64().is_some_and(f64::is_finite)
                {
                    return None;
                }
                saved["outputPreview"].take()
            } else {
                if call["status"] != "completed" || saved["status"] != "completed" {
                    return None;
                }
                saved["output"].take()
            };
            found = Some((output, saved["evidenceRefs"].take()));
        }
    }
    found
}

fn versions(paths: &[std::path::PathBuf]) -> Option<Vec<Option<files::FileIdentity>>> {
    paths
        .iter()
        .map(|path| files::identity(path).ok())
        .collect()
}

fn read_evidence_tail(
    path: &Path,
    reference: &InteractiveResultReference,
    locator: &str,
) -> Option<(Value, files::FileIdentity)> {
    let (mut file, before) = files::open(path, u64::MAX).ok()??;
    let length = before.size.min(EVIDENCE_TAIL_BYTES);
    let start = before.size.checked_sub(length)?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut tail).ok()?;
    if tail.len() as u64 != length || files::identity(path).ok()?.as_ref() != Some(&before) {
        return None;
    }
    let lines = if start == 0 {
        tail.as_slice()
    } else {
        let first_complete = tail.iter().position(|b| *b == b'\n')? + 1;
        &tail[first_complete..]
    };
    let mut mentions_artifact = false;
    for line in lines
        .rsplit(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
    {
        let Some(row) = decode(line, INTERACTIVE_EVIDENCE_LINE_BYTES) else {
            continue;
        };
        if row["evidenceRef"] != locator {
            continue;
        }
        mentions_artifact |= included(&row["artifactRefs"], locator);
        if artifact(&row, reference, locator).is_some() && row["toolName"] != "goal_update_task" {
            let mut canonical = row;
            if mentions_artifact {
                canonical["artifactRefs"] = json!([locator]);
            }
            return Some((canonical, before));
        }
        // Older writers may append a delivery wrapper or a view that retained
        // the reference but lost the structured kind. Keep looking for source.
        if row["toolName"] != "goal_update_task" && !mentions_artifact {
            return None;
        }
    }
    None
}

const INTERACTIVE_EVIDENCE_LINE_BYTES: usize = 1024 * 1024;
