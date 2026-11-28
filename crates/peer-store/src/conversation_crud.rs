//! Classic desktop-compatible conversation CRUD, windowed reads, and search.
//! Shares the canonical `conversations/index.jsonl` and `<id>.jsonl` layout,
//! DirectoryLock ordering, and `.changes.json` notifications with TS stores.

use crate::{
    ConversationStore, DirectoryLock, StoreError, context_model_key, conversation_execution,
    conversation_preview::preview, durable_jsonl as log, files, valid_id,
};
use peer_protocol::{JsonLimits, decode_json_bounded, javascript_json_string};
use serde_json::{Map, Value, json};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const DEFAULT_OPEN_WINDOW: usize = 80;
const MAX_OPEN_WINDOW: usize = 200;
const DEFAULT_LIST_LIMIT: usize = 500;
const CHUNK_BYTES: usize = 64 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ConversationListQuery {
    pub workspace_path: Option<Option<String>>,
    pub statuses: Option<Vec<String>>,
    pub roles: Option<Vec<String>>,
    pub include_message_count: bool,
    pub limit: Option<usize>,
    pub cursor: Option<String>,
    pub paginated: bool,
}

#[derive(Debug, Clone)]
pub struct ConversationSearchQuery {
    pub query: String,
    pub workspace_path: Option<Option<String>>,
    pub statuses: Option<Vec<String>>,
    pub roles: Option<Vec<String>>,
    pub limit: usize,
    pub include_workspace_name_match: bool,
}

impl Default for ConversationSearchQuery {
    fn default() -> Self {
        Self {
            query: String::new(),
            workspace_path: None,
            statuses: Some(vec!["active".to_owned()]),
            roles: None,
            limit: 50,
            include_workspace_name_match: false,
        }
    }
}

fn now_iso() -> Result<String, StoreError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| StoreError::InvalidInput)
}

fn normalize_mode(value: Option<&str>) -> &'static str {
    match value {
        Some("plan") => "plan",
        Some("goal") => "goal",
        _ => "chat",
    }
}

fn normalize_effort(value: Option<&str>) -> &'static str {
    match value {
        Some("off") => "off",
        Some("low") => "low",
        Some("high") => "high",
        Some("xhigh") => "xhigh",
        Some("max") => "max",
        _ => "default",
    }
}

fn normalize_isolation(value: Option<&str>) -> &'static str {
    if value == Some("worktree") {
        "worktree"
    } else {
        "none"
    }
}

fn normalize_status(value: Option<&str>) -> &'static str {
    if value == Some("archived") {
        "archived"
    } else {
        "active"
    }
}

fn trimmed_non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn normalize_automation_origin(origin: &Value) -> Option<Value> {
    let obj = origin.as_object()?;
    if obj.get("kind").and_then(Value::as_str) != Some("automation_run") {
        return None;
    }
    let automation_id = trimmed_non_empty(obj.get("automationId")?)?;
    let run_id = trimmed_non_empty(obj.get("runId")?)?;
    let automation_name = obj
        .get("automationName")
        .and_then(Value::as_str)
        .map(peer_protocol::javascript_trim)
        .unwrap_or("")
        .to_owned();
    let trigger_source = match obj.get("triggerSource").and_then(Value::as_str) {
        Some("scheduled") => "scheduled",
        Some("retry") => "retry",
        _ => "manual",
    };
    let mut out = json!({
        "kind": "automation_run",
        "automationId": automation_id,
        "runId": run_id,
        "automationName": automation_name,
        "triggerSource": trigger_source,
    });
    if let Some(ws) = obj.get("originWorkspacePath").and_then(trimmed_non_empty) {
        out["originWorkspacePath"] = json!(ws);
    }
    if let Some(at) = obj.get("createdAt").and_then(trimmed_non_empty) {
        out["createdAt"] = json!(at);
    }
    Some(out)
}

fn normalize_delegation(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let session_id = trimmed_non_empty(obj.get("sessionId")?)?;
    let anchor_message_id = trimmed_non_empty(obj.get("anchorMessageId")?)?;
    let input_id = trimmed_non_empty(obj.get("inputId")?)?;
    Some(json!({
        "sessionId": session_id,
        "anchorMessageId": anchor_message_id,
        "inputId": input_id,
    }))
}

pub(crate) fn normalize_meta(mut row: Value) -> Value {
    let Some(obj) = row.as_object_mut() else {
        return row;
    };
    let status = normalize_status(obj.get("status").and_then(Value::as_str));
    let pinned_at = obj.get("pinnedAt").and_then(trimmed_non_empty);
    let pinned_order = if pinned_at.is_some() {
        obj.get("pinnedOrder")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| json!(n))
    } else {
        None
    };
    let content_revision = obj
        .get("contentRevision")
        .and_then(Value::as_f64)
        .filter(|r| r.is_finite() && *r >= 0.0 && r.fract() == 0.0 && *r <= 9_007_199_254_740_991.0)
        .map(|r| r as u64)
        .unwrap_or(0);
    let automation_origin = obj
        .get("automationOrigin")
        .and_then(normalize_automation_origin);
    obj.remove("automationOrigin");

    let mode = normalize_mode(obj.get("mode").and_then(Value::as_str));
    let fast_mode = obj.get("fastMode") == Some(&Value::Bool(true));
    let isolation = normalize_isolation(
        obj.get("preferredExecutionIsolation")
            .and_then(Value::as_str),
    );
    let effort = normalize_effort(obj.get("effort").and_then(Value::as_str));
    let model_provider_id = obj.get("modelProviderId").and_then(trimmed_non_empty);
    let model = obj.get("model").and_then(trimmed_non_empty);
    let last_read_at = obj.get("lastReadAt").and_then(trimmed_non_empty);
    let archived_at = if status == "archived" {
        obj.get("archivedAt")
            .and_then(trimmed_non_empty)
            .or_else(|| obj.get("updatedAt").and_then(trimmed_non_empty))
            .or_else(|| obj.get("createdAt").and_then(trimmed_non_empty))
    } else {
        None
    };

    obj.insert("contentRevision".into(), json!(content_revision));
    obj.insert("mode".into(), json!(mode));
    obj.insert("fastMode".into(), json!(fast_mode));
    obj.insert("preferredExecutionIsolation".into(), json!(isolation));
    obj.insert("effort".into(), json!(effort));
    obj.insert(
        "modelProviderId".into(),
        model_provider_id.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert(
        "model".into(),
        model.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert("status".into(), json!(status));
    obj.insert(
        "archivedAt".into(),
        archived_at.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert(
        "lastReadAt".into(),
        last_read_at.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert(
        "pinnedAt".into(),
        pinned_at.map(Value::String).unwrap_or(Value::Null),
    );
    obj.insert("pinnedOrder".into(), pinned_order.unwrap_or(Value::Null));

    if let Some(count) = obj
        .get("messageCount")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
    {
        obj.insert("messageCount".into(), json!(count as u64));
    } else {
        obj.remove("messageCount");
    }

    if let Some(origin) = automation_origin {
        obj.insert("automationOrigin".into(), origin);
    }

    if !matches!(
        obj.get("role").and_then(Value::as_str),
        Some("project_agent" | "work_session")
    ) {
        obj.remove("role");
    }
    if let Some(parent) = obj.get("parentConversationId").and_then(trimmed_non_empty) {
        obj.insert("parentConversationId".into(), json!(parent));
    } else {
        obj.remove("parentConversationId");
    }
    if let Some(ws_id) = obj.get("workspaceId").and_then(trimmed_non_empty) {
        obj.insert("workspaceId".into(), json!(ws_id));
    } else {
        obj.remove("workspaceId");
    }
    if let Some(delegation) = obj.get("delegation").and_then(normalize_delegation) {
        obj.insert("delegation".into(), delegation);
    } else {
        obj.remove("delegation");
    }

    row
}

fn conversation_role(meta: &Value) -> &str {
    match meta["role"].as_str() {
        Some("project_agent") => "project_agent",
        Some("work_session") => "work_session",
        _ => "default",
    }
}

fn accepts_role(meta: &Value, roles: Option<&Vec<String>>) -> bool {
    let Some(roles) = roles.filter(|list| !list.is_empty()) else {
        return conversation_role(meta) == "default";
    };
    let valid_requested: Vec<&str> = roles
        .iter()
        .map(String::as_str)
        .filter(|r| matches!(*r, "default" | "project_agent" | "work_session"))
        .collect();
    if valid_requested.is_empty() {
        return false;
    }
    valid_requested.contains(&conversation_role(meta))
}

fn sort_key(meta: &Value) -> &str {
    meta["updatedAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| meta["createdAt"].as_str())
        .unwrap_or("")
}

fn with_message_count(mut meta: Value) -> Value {
    if !meta["messageCount"].is_number()
        && let Some(obj) = meta.as_object_mut()
    {
        obj.insert("messageCount".into(), json!(0));
    }
    meta
}

fn workspace_short_name(workspace_path: &str) -> String {
    let trimmed = workspace_path.trim_end_matches(['/', '\\']);
    trimmed
        .split(['/', '\\'])
        .rfind(|part| !part.is_empty())
        .unwrap_or(trimmed)
        .to_lowercase()
}

fn rank_conversation_match(meta: &Value, query: &str, include_workspace_name_match: bool) -> i32 {
    let q = peer_protocol::javascript_trim(query).to_lowercase();
    if q.is_empty() {
        return 0;
    }
    let title = peer_protocol::javascript_trim(meta["title"].as_str().unwrap_or("")).to_lowercase();
    if title.contains(&q) {
        if title == q {
            return 300;
        }
        if title.starts_with(&q) {
            return 200;
        }
        return 100;
    }
    if include_workspace_name_match
        && let Some(ws) = meta["workspacePath"].as_str().filter(|s| !s.is_empty())
    {
        let ws_name = workspace_short_name(ws);
        if !ws_name.is_empty() && ws_name.contains(&q) {
            return 50;
        }
    }
    -1
}

fn is_empty_user_message(message: &Value) -> bool {
    if message["role"].as_str() != Some("user") {
        return false;
    }
    let content = message["content"].as_str().unwrap_or("");
    if !peer_protocol::javascript_trim(content).is_empty() {
        return false;
    }
    message["attachments"].as_array().is_none_or(Vec::is_empty)
}

fn is_ack_or_command_snippet(compact: &str) -> bool {
    let lower = compact.to_lowercase();
    if compact.starts_with("> ") || compact.starts_with("$ ") {
        return true;
    }
    if compact.contains('/')
        && ["tsc", "npm", "pnpm", "yarn", "node"]
            .iter()
            .any(|tool| lower.contains(tool))
    {
        return true;
    }
    let stripped = lower.trim_end_matches(['.', '!', '！', '。', '…', ' ']);
    if stripped == "就这么做" {
        return true;
    }
    for prefix in [
        "好", "好的", "行", "可以", "认可", "ok", "okay", "yes", "yep", "lgtm",
    ] {
        if stripped == prefix {
            return true;
        }
        if let Some(rest) = stripped.strip_prefix(prefix)
            && rest.starts_with([',', '，', '、', ' ', '\t'])
        {
            return true;
        }
    }
    false
}

fn build_draft_title(content: &str) -> (&'static str, String) {
    let compact = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if is_ack_or_command_snippet(&compact) {
        return ("fallback", "未命名沟通".to_owned());
    }
    let chars: Vec<char> = compact.chars().collect();
    if chars.len() <= 16 {
        ("user_snippet", compact)
    } else {
        let prefix: String = chars.into_iter().take(16).collect();
        ("user_snippet", format!("{prefix}…"))
    }
}

fn check_execution_available(meta: &Value, id: &str) -> Result<(), StoreError> {
    if conversation_execution::decode(meta, id)?.is_some_and(|run| !run.permits_new_run()) {
        return Err(StoreError::ExecutionBusy);
    }
    Ok(())
}

fn find_position(index: &[Value], id: &str) -> Option<usize> {
    index.iter().position(|row| row["id"] == id)
}

fn decode_jsonl_messages(path: &Path) -> Result<Vec<Value>, StoreError> {
    let Some((file, _)) = files::open(path, u64::MAX)? else {
        return Ok(Vec::new());
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    let mut out = Vec::new();
    loop {
        line.clear();
        let read = (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| StoreError::ReadFailed)?;
        if read == 0 {
            break;
        }
        if line.len() > MAX_LINE_BYTES {
            return Err(StoreError::HistoryLimit);
        }
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Ok(decoded) = decode_json_bounded(
            &line,
            JsonLimits {
                bytes: MAX_LINE_BYTES,
                nodes: 65_536,
                depth: 64,
                string_bytes: MAX_LINE_BYTES,
            },
        ) && decoded.value.is_object()
        {
            out.push(decoded.value);
        }
    }
    Ok(out)
}

fn encode_jsonl_messages(rows: &[Value]) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    for row in rows {
        let line = javascript_json_string(row).map_err(|_| StoreError::HistoryLimit)?;
        out.extend_from_slice(line.as_bytes());
        out.push(b'\n');
    }
    Ok(out)
}

fn extract_newest_lines(buffer: &[u8], base: u64, limit: usize) -> Vec<(u64, &[u8])> {
    let mut lines = Vec::new();
    let mut end = buffer.len();
    let at_file_start = base == 0;
    while lines.len() < limit && end > 0 {
        let newline = buffer[..end].iter().rposition(|&b| b == b'\n');
        match newline {
            None => {
                if at_file_start {
                    lines.push((base, &buffer[..end]));
                }
                break;
            }
            Some(pos) => {
                let line_start = pos + 1;
                if end > line_start {
                    lines.push((base + line_start as u64, &buffer[line_start..end]));
                }
                end = pos;
            }
        }
    }
    lines
}

fn read_jsonl_byte_window(
    path: &Path,
    limit: usize,
    before_byte: Option<u64>,
) -> Result<(Vec<Value>, Option<String>, bool), StoreError> {
    let Some((mut file, identity)) = files::open(path, u64::MAX)? else {
        return Ok((Vec::new(), None, false));
    };
    let size = identity.size;
    let mut end = match before_byte {
        Some(0) => return Ok((Vec::new(), None, false)),
        Some(before) => before.min(size),
        None => size,
    };
    if end == 0 {
        return Ok((Vec::new(), None, false));
    }

    let mut pieces: Vec<Vec<u8>> = Vec::new();
    let mut position = end;
    let mut newlines = 0usize;

    let mut read_older = |position: &mut u64,
                          pieces: &mut Vec<Vec<u8>>,
                          newlines: &mut usize|
     -> Result<bool, StoreError> {
        if *position == 0 {
            return Ok(false);
        }
        let read_size = (CHUNK_BYTES as u64).min(*position) as usize;
        let start = *position - read_size as u64;
        file.seek(SeekFrom::Start(start))
            .map_err(|_| StoreError::ReadFailed)?;
        let mut buf = vec![0u8; read_size];
        let count = file.read(&mut buf).map_err(|_| StoreError::ReadFailed)?;
        if count == 0 {
            *position = start;
            return Ok(false);
        }
        buf.truncate(count);
        *newlines += buf.iter().filter(|&&b| b == b'\n').count();
        pieces.push(buf);
        *position = start;
        Ok(true)
    };

    while position > 0 && newlines < limit {
        if !read_older(&mut position, &mut pieces, &mut newlines)? {
            break;
        }
    }

    let join_pieces = |pieces: &[Vec<u8>]| -> Vec<u8> {
        if pieces.is_empty() {
            return Vec::new();
        }
        let total: usize = pieces.iter().map(Vec::len).sum();
        let mut combined = Vec::with_capacity(total);
        for chunk in pieces.iter().rev() {
            combined.extend_from_slice(chunk);
        }
        combined
    };

    let mut combined = join_pieces(&pieces);
    let mut line_count = extract_newest_lines(&combined, position, limit).len();
    while line_count < limit && position > 0 {
        let before_newlines = newlines;
        while position > 0 && newlines == before_newlines {
            if !read_older(&mut position, &mut pieces, &mut newlines)? {
                break;
            }
        }
        combined = join_pieces(&pieces);
        line_count = extract_newest_lines(&combined, position, limit).len();
    }

    let mut lines = extract_newest_lines(&combined, position, limit);
    lines.reverse();

    let mut messages = Vec::with_capacity(lines.len());
    let mut oldest_byte_start: Option<u64> = None;
    for (byte_start, slice) in lines {
        if oldest_byte_start.is_none() {
            oldest_byte_start = Some(byte_start);
        }
        if slice.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Ok(decoded) = decode_json_bounded(
            slice,
            JsonLimits {
                bytes: MAX_LINE_BYTES,
                nodes: 65_536,
                depth: 64,
                string_bytes: MAX_LINE_BYTES,
            },
        ) && decoded.value.is_object()
        {
            messages.push(decoded.value);
        }
    }

    let has_more = oldest_byte_start.is_some_and(|start| start > 0);
    let cursor = if has_more {
        oldest_byte_start.map(|start| start.to_string())
    } else {
        None
    };
    let _ = &mut end;
    Ok((messages, cursor, has_more))
}

fn merge_stream_patch(stream_file: &Path, messages: &mut [Value]) {
    let Ok(Some(bytes)) = files::read(stream_file, log::MAX_BYTES) else {
        return;
    };
    let Ok(sidecar) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    if sidecar["version"].as_f64() != Some(1.0) {
        return;
    }
    let Some(message_id) = sidecar["messageId"].as_str().filter(|s| !s.is_empty()) else {
        return;
    };
    let Some(patch) = sidecar["patch"].as_object() else {
        return;
    };
    if let Some(target) = messages
        .iter_mut()
        .find(|m| m["id"].as_str() == Some(message_id))
        && let Some(obj) = target.as_object_mut()
    {
        for (k, v) in patch {
            obj.insert(k.clone(), v.clone());
        }
    }
}

impl ConversationStore {
    fn index_path(&self) -> std::path::PathBuf {
        self.directory.join("index.jsonl")
    }

    fn read_index_rows(&self) -> Result<Vec<Value>, StoreError> {
        let path = self.index_path();
        if files::identity(&path)?.is_none() {
            return Ok(Vec::new());
        }
        let rows = log::read(&path, None)?;
        Ok(rows.into_iter().map(normalize_meta).collect())
    }

    fn write_change_event(&self, meta: &Value, change_type: &str) {
        let change_file = self.directory.join(".changes.json");
        let epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let changed_at = now_iso().unwrap_or_default();
        let event = json!({
            "conversationId": meta["id"],
            "workspacePath": meta.get("workspacePath").cloned().unwrap_or(Value::Null),
            "changeType": change_type,
            "revision": format!("{epoch_ms}-{}", uuid::Uuid::new_v4()),
            "writerPid": std::process::id(),
            "changedAt": changed_at,
        });
        if let Ok(bytes) = serde_json::to_vec(&event) {
            let _ = fs::write(&change_file, bytes);
        }
    }

    pub fn list_conversations_view(
        &self,
        query: &ConversationListQuery,
    ) -> Result<Value, StoreError> {
        let allowed_statuses: Option<Vec<&'static str>> = query.statuses.as_ref().map(|items| {
            items
                .iter()
                .map(|s| normalize_status(Some(s.as_str())))
                .collect()
        });
        let rows = self.read_index_rows()?;
        let mut filtered: Vec<Value> = rows
            .into_iter()
            .filter(|meta| {
                if let Some(ref ws_filter) = query.workspace_path {
                    let requested = ws_filter.as_deref().filter(|s| !s.is_empty());
                    let exec_ws = meta["workspacePath"].as_str().filter(|s| !s.is_empty());
                    let auto_ws = meta["automationOrigin"]["originWorkspacePath"]
                        .as_str()
                        .filter(|s| !s.is_empty());
                    if exec_ws != requested && auto_ws != requested {
                        return false;
                    }
                }
                if let Some(ref statuses) = allowed_statuses {
                    let status = normalize_status(meta["status"].as_str());
                    if !statuses.contains(&status) {
                        return false;
                    }
                }
                accepts_role(meta, query.roles.as_ref())
            })
            .collect();

        filtered.sort_by(|a, b| sort_key(b).cmp(sort_key(a)));

        let projected: Vec<Value> = if query.include_message_count {
            filtered.into_iter().map(with_message_count).collect()
        } else {
            filtered
        };

        let wants_page = query.paginated || query.limit.is_some() || query.cursor.is_some();
        if !wants_page {
            return Ok(Value::Array(projected));
        }

        let total = projected.len();
        let start = query
            .cursor
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .and_then(|cursor| projected.iter().position(|item| item["id"] == cursor))
            .map(|idx| idx + 1)
            .unwrap_or(0);

        let page_items: Vec<Value> = match query.limit {
            Some(limit) => {
                let capped = limit.clamp(1, DEFAULT_LIST_LIMIT);
                projected.into_iter().skip(start).take(capped).collect()
            }
            None => projected.into_iter().skip(start).collect(),
        };
        let end = start + page_items.len();
        let has_more = query.limit.is_some() && end < total;
        let next_cursor = if has_more {
            page_items
                .last()
                .and_then(|item| item["id"].as_str())
                .map(str::to_owned)
        } else {
            None
        };

        Ok(json!({
            "items": page_items,
            "nextCursor": next_cursor,
            "hasMore": has_more,
            "total": total,
        }))
    }

    pub fn list_all_metas_with_counts(&self) -> Result<Vec<Value>, StoreError> {
        let rows = self.read_index_rows()?;
        Ok(rows.into_iter().map(with_message_count).collect())
    }

    pub fn search_conversations(
        &self,
        query: &ConversationSearchQuery,
    ) -> Result<Vec<Value>, StoreError> {
        let allowed_statuses: Option<Vec<&'static str>> = query.statuses.as_ref().map(|items| {
            items
                .iter()
                .map(|s| normalize_status(Some(s.as_str())))
                .collect()
        });
        let limit = if query.limit == 0 { 50 } else { query.limit };
        let q = peer_protocol::javascript_trim(&query.query);
        let rows = self.read_index_rows()?;

        let mut filtered: Vec<Value> = rows
            .into_iter()
            .filter(|meta| {
                if let Some(ref statuses) = allowed_statuses {
                    let status = normalize_status(meta["status"].as_str());
                    if !statuses.contains(&status) {
                        return false;
                    }
                }
                if let Some(ref ws_filter) = query.workspace_path {
                    let requested = ws_filter.as_deref().filter(|s| !s.is_empty());
                    let exec_ws = meta["workspacePath"].as_str().filter(|s| !s.is_empty());
                    if exec_ws != requested {
                        return false;
                    }
                }
                accepts_role(meta, query.roles.as_ref())
            })
            .collect();

        if q.is_empty() {
            filtered.sort_by(|a, b| sort_key(b).cmp(sort_key(a)));
            filtered.truncate(limit);
            return Ok(filtered);
        }

        let mut ranked: Vec<(i32, Value)> = filtered
            .into_iter()
            .filter_map(|meta| {
                let score = rank_conversation_match(&meta, q, query.include_workspace_name_match);
                (score >= 0).then_some((score, meta))
            })
            .collect();

        ranked.sort_by(|(score_a, meta_a), (score_b, meta_b)| {
            score_b
                .cmp(score_a)
                .then_with(|| sort_key(meta_b).cmp(sort_key(meta_a)))
        });

        Ok(ranked.into_iter().take(limit).map(|(_, m)| m).collect())
    }

    pub fn create_classic_conversation(&self, params: &Value) -> Result<Value, StoreError> {
        if let Some(role) = params.get("role").filter(|v| !v.is_null())
            && !matches!(role.as_str(), Some("project_agent" | "work_session"))
        {
            return Err(StoreError::InvalidInput);
        }
        let title = params["title"].as_str().unwrap_or("");
        let workspace_path = params.get("workspacePath").and_then(trimmed_non_empty);
        let mode = normalize_mode(params["mode"].as_str());
        let fast_mode = params["fastMode"] == Value::Bool(true);
        let preferred_isolation =
            normalize_isolation(params["preferredExecutionIsolation"].as_str());
        let automation_origin = params
            .get("automationOrigin")
            .and_then(normalize_automation_origin);
        let workspace_id = params.get("workspaceId").and_then(trimmed_non_empty);
        let role = params.get("role").and_then(trimmed_non_empty);
        let model_provider_id = params
            .get("modelProviderId")
            .and_then(trimmed_non_empty)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let now = now_iso()?;

        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = if files::identity(&file)?.is_some() {
            log::read(&file, None)?
        } else {
            Vec::new()
        };

        let mut meta = json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "title": title,
            "workspacePath": workspace_path,
            "mode": mode,
            "fastMode": fast_mode,
            "preferredExecutionIsolation": preferred_isolation,
            "effort": "default",
            "modelProviderId": model_provider_id,
            "status": "active",
            "archivedAt": Value::Null,
            "lastReadAt": now,
            "pinnedAt": Value::Null,
            "pinnedOrder": Value::Null,
            "messageCount": 0,
            "contentRevision": 0,
            "contextSnapshot": Value::Null,
            "createdAt": now,
            "updatedAt": now,
        });
        if let Some(ctx) = params
            .get("automationCreateContext")
            .filter(|v| !v.is_null())
        {
            meta["automationCreateContext"] = ctx.clone();
        }
        if let Some(origin) = automation_origin {
            meta["automationOrigin"] = origin;
        }
        if let Some(role) = role {
            meta["role"] = json!(role);
        }
        if let Some(ws_id) = workspace_id {
            meta["workspaceId"] = json!(ws_id);
        }
        preview(&mut meta, &[]);
        index.push(meta.clone());
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&meta, "created");
        Ok(meta)
    }

    fn read_full_window_messages(&self, id: &str) -> Result<Vec<Value>, StoreError> {
        let mut messages = decode_jsonl_messages(&self.directory.join(format!("{id}.jsonl")))?;
        merge_stream_patch(
            &self.directory.join(format!("{id}.stream.json")),
            &mut messages,
        );
        Ok(messages)
    }

    /// Share one validated index across a read-only list projection. Read each
    /// requested body on demand so callers need not hold all histories in memory.
    pub fn indexed_full_message_reader(
        &self,
    ) -> impl Fn(&str) -> Result<Option<Vec<Value>>, StoreError> + '_ {
        let known = self.read_index_rows().map(|rows| {
            rows.into_iter()
                .filter_map(|row| row["id"].as_str().map(str::to_owned))
                .collect::<HashSet<_>>()
        });
        move |id: &str| {
            if !valid_id(id, false) {
                return Err(StoreError::InvalidInput);
            }
            known
                .as_ref()
                .map_err(|error| *error)?
                .contains(id)
                .then(|| self.read_full_window_messages(id))
                .transpose()
        }
    }

    pub fn read_conversation_window(
        &self,
        id: &str,
        limit: Option<usize>,
        before: Option<&str>,
        full: bool,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let rows = self.read_index_rows()?;
        let Some(meta) = rows.into_iter().find(|row| row["id"] == id) else {
            return Ok(None);
        };
        let meta = with_message_count(meta);
        let body_path = self.directory.join(format!("{id}.jsonl"));
        let stream_path = self.directory.join(format!("{id}.stream.json"));

        if full {
            let messages = self.read_full_window_messages(id)?;
            return Ok(Some(json!({
                "meta": meta,
                "window": messages,
                "cursor": Value::Null,
                "hasMore": false,
            })));
        }

        let before_byte = if let Some(raw_before) = before.filter(|s| !s.is_empty()) {
            if !raw_before.bytes().all(|b| b.is_ascii_digit()) {
                return Ok(Some(json!({
                    "meta": meta,
                    "window": [],
                    "cursor": Value::Null,
                    "hasMore": false,
                })));
            }
            match raw_before.parse::<u64>() {
                Ok(val) if val <= 9_007_199_254_740_991 => Some(val),
                _ => {
                    return Ok(Some(json!({
                        "meta": meta,
                        "window": [],
                        "cursor": Value::Null,
                        "hasMore": false,
                    })));
                }
            }
        } else {
            None
        };

        let window_limit = limit
            .filter(|&l| l > 0)
            .map(|l| l.min(MAX_OPEN_WINDOW))
            .unwrap_or(DEFAULT_OPEN_WINDOW);
        let (mut messages, cursor, has_more) =
            read_jsonl_byte_window(&body_path, window_limit, before_byte)?;
        merge_stream_patch(&stream_path, &mut messages);

        Ok(Some(json!({
            "meta": meta,
            "window": messages,
            "cursor": cursor,
            "hasMore": has_more,
        })))
    }

    pub fn update_title(
        &self,
        id: &str,
        title: &str,
        source: Option<&str>,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        let now = now_iso()?;
        index[pos]["title"] = json!(title);
        index[pos]["titleSource"] = json!(
            source
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("manual")
        );
        index[pos]["updatedAt"] = json!(now);
        preview(&mut index[pos], &[]);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn update_mode_classic(&self, id: &str, mode: &str) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        check_execution_available(&index[pos], id)?;
        index[pos]["mode"] = json!(normalize_mode(Some(mode)));
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn update_fast_mode(&self, id: &str, fast_mode: bool) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        check_execution_available(&index[pos], id)?;
        index[pos]["fastMode"] = json!(fast_mode);
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn update_preferred_execution_isolation(
        &self,
        id: &str,
        isolation: &str,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        index[pos]["preferredExecutionIsolation"] = json!(normalize_isolation(Some(isolation)));
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn update_workspace_path(
        &self,
        id: &str,
        workspace_path: &str,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let trimmed = peer_protocol::javascript_trim(workspace_path);
        if trimmed.is_empty() || trimmed.len() > 16_384 {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        index[pos]["workspacePath"] = json!(trimmed);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn update_model_effort_classic(
        &self,
        id: &str,
        effort: Option<&str>,
        model_provider_id: Option<Option<&str>>,
        model: Option<Option<&str>>,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        check_execution_available(&index[pos], id)?;

        let normalized_before = normalize_meta(index[pos].clone());
        let before_key = context_model_key(&normalized_before);

        if let Some(eff) = effort {
            index[pos]["effort"] = json!(normalize_effort(Some(eff)));
        }
        if let Some(mp_opt) = model_provider_id {
            let next_mp = mp_opt
                .map(peer_protocol::javascript_trim)
                .filter(|s| !s.is_empty());
            index[pos]["modelProviderId"] = next_mp.map(|s| json!(s)).unwrap_or(Value::Null);
        }
        if let Some(m_opt) = model {
            let next_m = m_opt
                .map(peer_protocol::javascript_trim)
                .filter(|s| !s.is_empty());
            index[pos]["model"] = next_m.map(|s| json!(s)).unwrap_or(Value::Null);
        }

        let normalized_after = normalize_meta(index[pos].clone());
        if context_model_key(&normalized_after) != before_key {
            index[pos]["contextSnapshot"] = Value::Null;
        }
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn append_classic_message(
        &self,
        id: &str,
        message: &Value,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) || !message.is_object() {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, Some(id), None)?;
        let index_file = directory.join("index.jsonl");
        let mut index = log::read(&index_file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };

        if is_empty_user_message(message) {
            return Ok(Some(with_message_count(normalize_meta(index[pos].clone()))));
        }
        check_execution_available(&index[pos], id)?;

        let body_file = directory.join(format!("{id}.jsonl"));
        let line = encode_jsonl_messages(std::slice::from_ref(message))?;
        log::append(&body_file, &line, None)?;

        let missing_title = index[pos]["title"].as_str().is_none_or(|s| s.is_empty());
        if missing_title
            && message["role"].as_str() == Some("user")
            && let Some(content) = message["content"].as_str()
            && !peer_protocol::javascript_trim(content).is_empty()
        {
            let (source, draft) = build_draft_title(content);
            index[pos]["title"] = json!(draft);
            index[pos]["titleSource"] = json!(source);
        }

        let next_count = if let Some(prev) = index[pos]["messageCount"].as_u64() {
            prev + 1
        } else {
            decode_jsonl_messages(&body_file)?.len() as u64
        };
        let next_rev = index[pos]["contentRevision"].as_u64().unwrap_or(0) + 1;
        index[pos]["messageCount"] = json!(next_count);
        index[pos]["contentRevision"] = json!(next_rev);
        index[pos]["contextSnapshot"] = Value::Null;
        index[pos]["updatedAt"] = json!(now_iso()?);
        preview(&mut index[pos], std::slice::from_ref(message));
        let meta = normalize_meta(index[pos].clone());
        log::replace(&index_file, &log::encode(&index)?, None)?;
        self.write_change_event(&meta, "messages-updated");
        Ok(Some(meta))
    }

    pub fn update_last_message(
        &self,
        id: &str,
        content: &Value,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, Some(id), None)?;
        let index_file = directory.join("index.jsonl");
        let mut index = log::read(&index_file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        check_execution_available(&index[pos], id)?;

        let body_file = directory.join(format!("{id}.jsonl"));
        let mut messages = decode_jsonl_messages(&body_file)?;
        if messages.is_empty() {
            return Ok(None);
        }
        if let Some(last) = messages.last_mut().and_then(Value::as_object_mut) {
            last.insert("content".into(), content.clone());
        }
        log::replace(&body_file, &encode_jsonl_messages(&messages)?, None)?;

        let next_rev = index[pos]["contentRevision"].as_u64().unwrap_or(0) + 1;
        index[pos]["contentRevision"] = json!(next_rev);
        index[pos]["contextSnapshot"] = Value::Null;
        index[pos]["updatedAt"] = json!(now_iso()?);
        preview(&mut index[pos], &messages);
        let mut out = normalize_meta(index[pos].clone());
        log::replace(&index_file, &log::encode(&index)?, None)?;
        self.write_change_event(&out, "messages-updated");
        if let Some(obj) = out.as_object_mut() {
            obj.insert("messages".into(), Value::Array(messages));
        }
        Ok(Some(out))
    }

    pub fn replace_messages(
        &self,
        id: &str,
        new_messages: &[Value],
        allow_empty: bool,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, Some(id), None)?;
        let index_file = directory.join("index.jsonl");
        let mut index = log::read(&index_file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        check_execution_available(&index[pos], id)?;

        let body_file = directory.join(format!("{id}.jsonl"));
        let existing = decode_jsonl_messages(&body_file)?;
        let durable: Vec<Value> = new_messages
            .iter()
            .filter(|m| !is_empty_user_message(m))
            .cloned()
            .collect();
        if durable.is_empty() && !existing.is_empty() && !allow_empty {
            return Err(StoreError::InvalidInput);
        }
        log::replace(&body_file, &encode_jsonl_messages(&durable)?, None)?;

        let next_rev = index[pos]["contentRevision"].as_u64().unwrap_or(0) + 1;
        index[pos]["messageCount"] = json!(durable.len());
        index[pos]["contentRevision"] = json!(next_rev);
        index[pos]["contextSnapshot"] = Value::Null;
        index[pos]["updatedAt"] = json!(now_iso()?);
        preview(&mut index[pos], &durable);
        let mut out = normalize_meta(index[pos].clone());
        log::replace(&index_file, &log::encode(&index)?, None)?;
        self.write_change_event(&out, "messages-updated");
        if let Some(obj) = out.as_object_mut() {
            obj.insert("messages".into(), Value::Array(durable));
        }
        Ok(Some(out))
    }

    pub fn set_archive_status(
        &self,
        id: &str,
        archived: bool,
    ) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        let now = now_iso()?;
        index[pos]["status"] = json!(if archived { "archived" } else { "active" });
        index[pos]["archivedAt"] = if archived { json!(now) } else { Value::Null };
        if archived {
            index[pos]["pinnedAt"] = Value::Null;
            index[pos]["pinnedOrder"] = Value::Null;
        }
        index[pos]["updatedAt"] = json!(now);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn pin_conversation(&self, id: &str) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        if normalize_status(index[pos]["status"].as_str()) == "archived" {
            return Ok(Some(with_message_count(normalize_meta(index[pos].clone()))));
        }
        let now = now_iso()?;
        if index[pos]["pinnedAt"]
            .as_str()
            .is_none_or(|s| s.trim().is_empty())
        {
            let seed = index
                .iter()
                .filter(|row| {
                    row["pinnedAt"]
                        .as_str()
                        .is_some_and(|s| !s.trim().is_empty())
                })
                .filter_map(|row| row["pinnedOrder"].as_i64())
                .min()
                .map(|min_order| min_order - 1)
                .unwrap_or(0);
            index[pos]["pinnedAt"] = json!(now);
            index[pos]["pinnedOrder"] = json!(seed);
        }
        index[pos]["updatedAt"] = json!(now);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn unpin_conversation(&self, id: &str) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        index[pos]["pinnedAt"] = Value::Null;
        index[pos]["pinnedOrder"] = Value::Null;
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = with_message_count(normalize_meta(index[pos].clone()));
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(updated))
    }

    pub fn reorder_pinned(&self, ids: &[String]) -> Result<Value, StoreError> {
        let directory = self.write_directory()?;
        let _held = [DirectoryLock::acquire(
            &directory.join("index.jsonl"),
            std::time::Duration::from_millis(100),
            None,
        )?];
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;

        let mut pinned: Vec<(i64, String)> = index
            .iter()
            .filter(|row| {
                row["pinnedAt"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                    && normalize_status(row["status"].as_str()) == "active"
            })
            .filter_map(|row| {
                let id = row["id"].as_str()?.to_owned();
                let order = row["pinnedOrder"].as_i64().unwrap_or(0);
                Some((order, id))
            })
            .collect();
        pinned.sort_by_key(|(order, _)| *order);

        let pinned_ids: std::collections::HashSet<&str> =
            pinned.iter().map(|(_, id)| id.as_str()).collect();
        let mut next_ids: Vec<String> = ids
            .iter()
            .filter(|id| pinned_ids.contains(id.as_str()))
            .cloned()
            .collect();
        for (_, existing_id) in &pinned {
            if !next_ids.contains(existing_id) {
                next_ids.push(existing_id.clone());
            }
        }
        let order_by_id: Map<String, Value> = next_ids
            .into_iter()
            .enumerate()
            .map(|(i, id)| (id, json!(i)))
            .collect();
        for row in &mut index {
            if let Some(id) = row["id"].as_str()
                && let Some(order) = order_by_id.get(id)
            {
                row["pinnedOrder"] = order.clone();
            }
        }
        log::replace(&file, &log::encode(&index)?, None)?;

        self.list_conversations_view(&ConversationListQuery {
            statuses: Some(vec!["active".to_owned()]),
            include_message_count: true,
            ..Default::default()
        })
    }

    pub fn auto_archive(&self, before: &str, exclude_ids: &[String]) -> Result<Value, StoreError> {
        let Ok(cutoff) = OffsetDateTime::parse(before, &Rfc3339) else {
            return Ok(json!({ "archivedIds": [], "archivedCount": 0 }));
        };
        let excluded: std::collections::HashSet<&str> = exclude_ids
            .iter()
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .collect();
        let directory = self.write_directory()?;
        let _held = [DirectoryLock::acquire(
            &directory.join("index.jsonl"),
            std::time::Duration::from_millis(100),
            None,
        )?];
        let file = directory.join("index.jsonl");
        if files::identity(&file)?.is_none() {
            return Ok(json!({ "archivedIds": [], "archivedCount": 0 }));
        }
        let mut index = log::read(&file, None)?;
        let now = now_iso()?;
        let mut archived_ids = Vec::new();
        for row in &mut index {
            if normalize_status(row["status"].as_str()) != "active" {
                continue;
            }
            let Some(id) = row["id"].as_str() else {
                continue;
            };
            if excluded.contains(id) {
                continue;
            }
            let updated_str = row["updatedAt"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| row["createdAt"].as_str())
                .unwrap_or("");
            let Ok(updated_ts) = OffsetDateTime::parse(updated_str, &Rfc3339) else {
                continue;
            };
            if updated_ts >= cutoff {
                continue;
            }
            archived_ids.push(json!(id));
            row["status"] = json!("archived");
            row["archivedAt"] = json!(now);
            row["pinnedAt"] = Value::Null;
            row["pinnedOrder"] = Value::Null;
            row["updatedAt"] = json!(now);
        }
        if !archived_ids.is_empty() {
            log::replace(&file, &log::encode(&index)?, None)?;
        }
        Ok(json!({
            "archivedCount": archived_ids.len(),
            "archivedIds": archived_ids,
        }))
    }

    pub fn add_usage_classic(&self, id: &str, usage: &Value) -> Result<Option<Value>, StoreError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, None)?;
        let Some(pos) = find_position(&index, id) else {
            return Ok(None);
        };
        let prev = &index[pos]["lifetimeUsage"];
        let num = |v: &Value, key: &str| v[key].as_u64().unwrap_or(0);
        let next_usage = json!({
            "inputTokens": num(prev, "inputTokens") + num(usage, "inputTokens"),
            "outputTokens": num(prev, "outputTokens") + num(usage, "outputTokens"),
            "cacheWriteTokens": num(prev, "cacheWriteTokens") + num(usage, "cacheWriteTokens"),
            "cacheReadTokens": num(prev, "cacheReadTokens") + num(usage, "cacheReadTokens"),
        });
        index[pos]["lifetimeUsage"] = next_usage.clone();
        index[pos]["updatedAt"] = json!(now_iso()?);
        let updated = normalize_meta(index[pos].clone());
        log::replace(&file, &log::encode(&index)?, None)?;
        self.write_change_event(&updated, "metadata-updated");
        Ok(Some(next_usage))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crud_list_search_window_and_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = ConversationStore::new(dir.path());

        let c1 = store
            .create_classic_conversation(&json!({
                "title": "",
                "workspacePath": "/ws/alpha",
                "mode": "plan",
                "fastMode": true,
            }))
            .unwrap();
        let c1_id = c1["id"].as_str().unwrap().to_owned();
        assert_eq!(c1["mode"], "plan");
        assert_eq!(c1["fastMode"], true);

        let after_msg = store
            .append_classic_message(
                &c1_id,
                &json!({ "id": "m1", "role": "user", "content": "Inspect build pipeline" }),
            )
            .unwrap()
            .unwrap();
        assert!(after_msg.get("messages").is_none());
        assert_eq!(after_msg["messageCount"], 1);
        assert_eq!(after_msg["title"], "Inspect build pi…");

        let _ = store
            .append_classic_message(
                &c1_id,
                &json!({ "id": "m2", "role": "assistant", "content": "Running checks." }),
            )
            .unwrap()
            .unwrap();

        let page1 = store
            .read_conversation_window(&c1_id, Some(1), None, false)
            .unwrap()
            .unwrap();
        assert_eq!(page1["window"].as_array().unwrap().len(), 1);
        assert_eq!(page1["window"][0]["id"], "m2");
        assert_eq!(page1["hasMore"], true);

        let page2 = store
            .read_conversation_window(&c1_id, Some(1), page1["cursor"].as_str(), false)
            .unwrap()
            .unwrap();
        assert_eq!(page2["window"][0]["id"], "m1");
        assert_eq!(page2["hasMore"], false);

        let search_hits = store
            .search_conversations(&ConversationSearchQuery {
                query: "alpha".into(),
                include_workspace_name_match: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(search_hits.len(), 1);
        assert_eq!(search_hits[0]["id"], c1_id);

        let pinned = store.pin_conversation(&c1_id).unwrap().unwrap();
        assert!(pinned["pinnedAt"].is_string());

        let archived = store.set_archive_status(&c1_id, true).unwrap().unwrap();
        assert_eq!(archived["status"], "archived");
        assert!(archived["pinnedAt"].is_null());

        let restored = store.set_archive_status(&c1_id, false).unwrap().unwrap();
        assert_eq!(restored["status"], "active");

        let auto_conv = store
            .create_classic_conversation(&json!({
                "title": "Automation: Inspect",
                "workspacePath": "/ws/auto",
                "mode": "goal",
                "modelProviderId": "provider-auto-1",
                "automationOrigin": {
                    "kind": "automation_run",
                    "automationId": "auto-1",
                    "runId": "run-1",
                    "automationName": "Inspect",
                    "triggerSource": "scheduled",
                    "originWorkspacePath": "/ws/auto",
                    "createdAt": "2026-11-21T00:00:00Z"
                }
            }))
            .unwrap();
        assert_eq!(auto_conv["modelProviderId"], "provider-auto-1");
        assert_eq!(auto_conv["automationOrigin"]["kind"], "automation_run");
        assert_eq!(auto_conv["automationOrigin"]["automationId"], "auto-1");
    }
}
