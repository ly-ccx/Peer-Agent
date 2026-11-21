//! Project Agent Bot disk-backed operational RPC handlers:
//! - `project.bot.diagnostics`
//! - `project.bot.continueHistory`
//! - `project.bot.readInputDraft`
//! - `project.bot.writeInputDraft`
//! - `project.bot.readEvidence`

use crate::{project_bot::read_approval_jsonl_lines, protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BotProfileStore, InputDraftStore, InputQueue, ObjectiveStore, ProjectInbox, ProjectRegistry,
    SessionSupervisor, SubmitInputRequest, capture_inherited_background,
    is_safe_diagnostic_relative_path, is_valid_workspace_id, normalize_diagnostic_iso, now_iso,
    parse_iso_ms, redact_shell_output, sha256_hex, utf16_slice,
};
use peer_store::{ConversationStore, EvidenceIndexStore, HostLeaseStore, HostSurface, StoreError};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const INBOX_KINDS: [&str; 11] = [
    "session_started",
    "needs_user",
    "result_ready",
    "completed",
    "failed",
    "cancelled",
    "superseded",
    "user_intervened",
    "stalled",
    "progress",
    "objective_signal",
];
const OBJECTIVE_STATUSES: [&str; 4] = ["active", "paused", "achieved", "abandoned"];
const OBJECTIVE_AUTONOMIES: [&str; 3] = ["report_only", "propose", "act"];
const WATCH_KINDS: [&str; 2] = ["schedule", "event"];
const WATCH_SOURCES: [&str; 3] = ["git", "files", "task_event"];
const SCHEDULER_PRIORITIES: [&str; 3] = ["high", "normal", "low"];
const SCHEDULER_REASONS: [&str; 6] = [
    "dependencies",
    "dependency_missing",
    "dependency_failed",
    "read_slot",
    "write_slot",
    "isolated_slot",
];
const TURN_OUTCOMES: [&str; 3] = ["done", "error", "preempted"];
const EVIDENCE_KINDS: [&str; 5] = ["screenshot", "command", "diff", "file", "observation"];
const EVIDENCE_QUERY_TOOLS: [&str; 3] = ["get_session", "list_sessions", "get_verification_detail"];

fn ok_fail(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

fn push_unique_code(list: &mut Vec<&'static str>, code: &'static str) {
    if !list.contains(&code) {
        list.push(code);
    }
}

fn diagnostic_text(value: Option<&str>) -> Value {
    let Some(s) = value else {
        return Value::Null;
    };
    json!({
        "length": s.encode_utf16().count(),
        "sha256": sha256_hex(s.as_bytes()),
    })
}

fn enum_of<'a>(value: Option<&str>, allowed: &[&'a str]) -> &'a str {
    value
        .and_then(|v| allowed.iter().copied().find(|&a| a == v))
        .unwrap_or("unknown")
}

fn count_val(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_u64)
        .filter(|&n| n <= MAX_SAFE_INTEGER)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn iso_val(value: Option<&Value>) -> Value {
    value
        .and_then(Value::as_str)
        .and_then(normalize_diagnostic_iso)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn js_truthy(val: Option<&Value>) -> bool {
    match val {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn read_watch_state_map(data_home: &Path, workspace_id: &str) -> Result<Value, ()> {
    if !is_valid_workspace_id(workspace_id) || workspace_id.contains("..") {
        return Err(());
    }
    let path = data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("objectives")
        .join("watch-state.json");
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Ok(json!({ "schemaVersion": 1, "watches": {}, "reservations": {} }));
        }
        Err(_) => return Err(()),
    };
    let parsed: Value = serde_json::from_str(&raw).map_err(|_| ())?;
    let Some(obj) = parsed.as_object() else {
        return Err(());
    };
    if obj.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(());
    }
    let Some(watches) = obj.get("watches").and_then(Value::as_object) else {
        return Err(());
    };
    if watches.iter().any(|(k, v)| {
        k.len() != 64
            || !k.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            || !v.is_object()
    }) {
        return Err(());
    }
    let Some(reservations) = obj.get("reservations").and_then(Value::as_object) else {
        return Err(());
    };
    for (k, v) in reservations {
        let Some(r) = v.as_object() else {
            return Err(());
        };
        let Some(obj_id) = r.get("objectiveId").and_then(Value::as_str) else {
            return Err(());
        };
        if !is_scope_id(obj_id) {
            return Err(());
        }
        let Some(exec_key) = r.get("executionKey").and_then(Value::as_str) else {
            return Err(());
        };
        if sha256_hex(exec_key.as_bytes()) != *k {
            return Err(());
        }
        if r.get("at")
            .and_then(Value::as_str)
            .and_then(parse_iso_ms)
            .is_none()
        {
            return Err(());
        }
        if !matches!(
            r.get("status").and_then(Value::as_str),
            Some("reserved" | "completed")
        ) {
            return Err(());
        }
    }
    Ok(parsed)
}

fn sanitize_scheduler_snapshot(raw: &Value) -> Value {
    let Some(sched) = raw.as_object() else {
        return Value::Null;
    };
    let stats = sched.get("stats").and_then(Value::as_object);
    let queue = sched
        .get("queue")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|job| {
                    json!({
                        "workspace": diagnostic_text(job.get("workspaceId").and_then(Value::as_str)),
                        "plan": diagnostic_text(job.get("planId").and_then(Value::as_str)),
                        "priority": enum_of(job.get("priority").and_then(Value::as_str), &SCHEDULER_PRIORITIES),
                        "enqueuedAt": iso_val(job.get("at")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let projects = sched
        .get("projects")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|proj| {
                    let slots = proj.get("slots").and_then(Value::as_object);
                    let proj_queue = proj
                        .get("queue")
                        .and_then(Value::as_array)
                        .map(|q| {
                            q.iter()
                                .map(|job| {
                                    let reason = match job.get("reason") {
                                        Some(Value::Null) => Value::Null,
                                        other => Value::from(enum_of(
                                            other.and_then(Value::as_str),
                                            &SCHEDULER_REASONS,
                                        )),
                                    };
                                    json!({
                                        "session": diagnostic_text(job.get("sessionId").and_then(Value::as_str)),
                                        "priority": enum_of(job.get("priority").and_then(Value::as_str), &SCHEDULER_PRIORITIES),
                                        "enqueuedAt": iso_val(job.get("enqueuedAt")),
                                        "reason": reason,
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    json!({
                        "workspace": diagnostic_text(proj.get("workspaceId").and_then(Value::as_str)),
                        "slots": {
                            "read": count_val(slots.and_then(|s| s.get("read"))),
                            "write": count_val(slots.and_then(|s| s.get("write"))),
                            "isolated": count_val(slots.and_then(|s| s.get("isolated"))),
                        },
                        "queue": proj_queue,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "stats": {
            "active": count_val(stats.and_then(|s| s.get("active"))),
            "waiting": count_val(stats.and_then(|s| s.get("waiting"))),
            "limit": count_val(stats.and_then(|s| s.get("limit"))),
        },
        "queue": queue,
        "projects": projects,
    })
}

fn turn_timing(message: &Value) -> Value {
    let t = &message["meta"]["diagnosticTiming"];
    let started_norm = t
        .get("startedAt")
        .and_then(Value::as_str)
        .and_then(normalize_diagnostic_iso);
    let finished_norm = t
        .get("finishedAt")
        .and_then(Value::as_str)
        .and_then(normalize_diagnostic_iso);
    let started_ms = started_norm.as_deref().and_then(parse_iso_ms);
    let finished_ms = finished_norm.as_deref().and_then(parse_iso_ms);
    let dur_val = t.get("durationMs");
    let valid_dur = dur_val
        .and_then(Value::as_f64)
        .is_some_and(|d| d.is_finite() && d >= 0.0);
    let outcome = t
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|o| TURN_OUTCOMES.contains(o));
    let valid = matches!(
        (started_ms, finished_ms, valid_dur, outcome),
        (Some(s), Some(f), true, Some(_)) if f >= s
    );
    json!({
        "identity": diagnostic_text(message.get("id").and_then(Value::as_str)),
        "startedAt": if valid { started_norm.map(Value::from).unwrap_or(Value::Null) } else { Value::Null },
        "finishedAt": if valid { finished_norm.map(Value::from).unwrap_or(Value::Null) } else { Value::Null },
        "durationMs": if valid { dur_val.cloned().unwrap_or(Value::Null) } else { Value::Null },
        "outcome": if valid { outcome.unwrap_or("unknown") } else { "unknown" },
    })
}

// ---------------------------------------------------------------------------
// 1. project.bot.diagnostics
// ---------------------------------------------------------------------------

pub fn handle_bot_diagnostics(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let data_home = &ctx.config.data_home;
    let mut errors: Vec<&'static str> = Vec::new();

    let profile_store = BotProfileStore::new(data_home);
    let active_map: HashMap<String, Option<String>> = profile_store
        .list_workspace_ids()
        .into_iter()
        .filter_map(|ws_id| {
            let p = profile_store.read(&ws_id)?;
            (p.status != "archived").then_some((p.workspace_id, p.agent_conversation_id))
        })
        .collect();

    let projects: Vec<String> = match ProjectRegistry::new(data_home).diagnostic_snapshot() {
        Ok(entries) => entries
            .into_iter()
            .filter(|e| active_map.contains_key(&e.workspace_id))
            .map(|e| e.workspace_id)
            .collect(),
        Err(_) => {
            push_unique_code(&mut errors, "PROJECTS_UNAVAILABLE");
            Vec::new()
        }
    };

    let scheduler = if params_val
        .get("schedulerUnavailable")
        .and_then(Value::as_bool)
        == Some(true)
    {
        push_unique_code(&mut errors, "SCHEDULER_UNAVAILABLE");
        Value::Null
    } else if let Some(raw_sched) = params_val.get("scheduler").filter(|v| !v.is_null()) {
        if raw_sched.is_object() {
            sanitize_scheduler_snapshot(raw_sched)
        } else {
            push_unique_code(&mut errors, "SCHEDULER_UNAVAILABLE");
            Value::Null
        }
    } else {
        Value::Null
    };

    let lease_store = HostLeaseStore::new(data_home);
    let input_queue = InputQueue::new(data_home);
    let inbox = ProjectInbox::new(data_home);
    let objective_store = ObjectiveStore::new(data_home);
    let conv_store = ConversationStore::new(data_home);
    let runtime_root = data_home.join("project-runtime");

    let mut bots = Vec::with_capacity(projects.len());
    for ws in projects {
        let mut faults: Vec<&'static str> = Vec::new();

        let lease = match lease_store.inspect(&ws) {
            Ok(Some(rec)) => {
                let surface = match rec.surface {
                    HostSurface::Desktop => "desktop",
                    HostSurface::Tui => "tui",
                };
                json!({
                    "holder": diagnostic_text(Some(&rec.host_id)),
                    "surface": surface,
                    "pid": rec.pid,
                    "acquiredAt": normalize_diagnostic_iso(&rec.acquired_at).map(Value::from).unwrap_or(Value::Null),
                    "heartbeatAt": normalize_diagnostic_iso(&rec.heartbeat_at).map(Value::from).unwrap_or(Value::Null),
                })
            }
            Ok(None) => Value::Null,
            Err(_) => {
                push_unique_code(&mut faults, "LEASE_UNAVAILABLE");
                Value::Null
            }
        };

        let input = match input_queue.diagnostic_snapshot(&ws) {
            Ok(snap) => json!({
                "depth": snap.depth,
                "executionDepth": snap.execution_depth,
                "cursor": diagnostic_text(snap.cursor.as_deref()),
                "executedCursor": diagnostic_text(snap.executed_cursor.as_deref()),
            }),
            Err(_) => {
                push_unique_code(&mut faults, "INPUT_UNAVAILABLE");
                Value::Null
            }
        };

        let inbox_val = match inbox.diagnostic_snapshot(&ws) {
            Ok(snap) => {
                let events: Vec<Value> = snap
                    .events
                    .into_iter()
                    .map(|ev| {
                        json!({
                            "identity": diagnostic_text(ev.get("eventId").and_then(Value::as_str)),
                            "seq": count_val(ev.get("seq")),
                            "at": iso_val(ev.get("at")),
                            "kind": enum_of(ev.get("kind").and_then(Value::as_str), &INBOX_KINDS),
                        })
                    })
                    .collect();
                json!({
                    "cursor": snap.cursor,
                    "events": events,
                })
            }
            Err(_) => {
                push_unique_code(&mut faults, "INBOX_UNAVAILABLE");
                Value::Null
            }
        };

        let approvals_file = runtime_root.join(&ws).join("approvals.jsonl");
        let approvals: Vec<Value> = match fs::metadata(&approvals_file) {
            Ok(_) => {
                let mut folded = Vec::new();
                let mut pos = HashMap::new();
                read_approval_jsonl_lines(&approvals_file, &mut folded, &mut pos);
                folded
                    .into_iter()
                    .map(|(_, r)| r)
                    .filter(|r| matches!(r["state"].as_str(), Some("open" | "stale")))
                    .map(|r| {
                        json!({
                            "identity": diagnostic_text(r.get("approvalId").and_then(Value::as_str)),
                            "state": r["state"].as_str().unwrap_or("open"),
                            "capability": diagnostic_text(r.get("capabilityId").and_then(Value::as_str)),
                            "summary": diagnostic_text(r.get("summary").and_then(Value::as_str)),
                            "at": iso_val(r.get("createdAt")),
                        })
                    })
                    .collect()
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Vec::new(),
            Err(_) => {
                push_unique_code(&mut faults, "APPROVALS_UNAVAILABLE");
                Vec::new()
            }
        };

        let objectives_val: Vec<Value> = match objective_store.list(&ws) {
            Ok(items) => {
                let watch_state = read_watch_state_map(data_home, &ws);
                let watches_obj = watch_state
                    .as_ref()
                    .ok()
                    .and_then(|s| s.get("watches"))
                    .and_then(Value::as_object);
                let watch_corrupt = watch_state.is_err();
                items
                    .into_iter()
                    .map(|item| {
                        let watches: Vec<Value> = item
                            .watches
                            .iter()
                            .map(|watch| {
                                let watch_id = watch
                                    .get("watchId")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                if watch_corrupt {
                                    push_unique_code(&mut faults, "WATCH_UNAVAILABLE");
                                }
                                let key = sha256_hex(
                                    format!("{}:{}", item.objective_id, watch_id).as_bytes(),
                                );
                                let state = watches_obj.and_then(|m| m.get(&key));
                                let paths: Vec<String> = watch["source"]["paths"]
                                    .as_array()
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(Value::as_str)
                                            .filter(|p| is_safe_diagnostic_relative_path(p))
                                            .map(str::to_owned)
                                            .collect()
                                    })
                                    .unwrap_or_default();
                                let pending = state.is_some_and(|s| {
                                    js_truthy(s.get("pendingExecutionKey"))
                                        || js_truthy(s.get("pendingSignalExecutionKey"))
                                });
                                let unavailable =
                                    state.is_some_and(|s| js_truthy(s.get("unavailableReason")));
                                json!({
                                    "identity": diagnostic_text(watch.get("watchId").and_then(Value::as_str)),
                                    "kind": enum_of(watch.get("kind").and_then(Value::as_str), &WATCH_KINDS),
                                    "source": enum_of(watch["source"]["type"].as_str(), &WATCH_SOURCES),
                                    "paths": paths,
                                    "lastObservationAt": iso_val(state.and_then(|s| s.get("lastObservationAt"))),
                                    "nextRunAt": iso_val(state.and_then(|s| s.get("nextRunAt"))),
                                    "pending": pending,
                                    "unavailable": unavailable,
                                })
                            })
                            .collect();
                        json!({
                            "identity": diagnostic_text(Some(&item.objective_id)),
                            "status": enum_of(Some(&item.status), &OBJECTIVE_STATUSES),
                            "autonomy": enum_of(Some(&item.autonomy), &OBJECTIVE_AUTONOMIES),
                            "watches": watches,
                        })
                    })
                    .collect()
            }
            Err(_) => {
                push_unique_code(&mut faults, "OBJECTIVES_UNAVAILABLE");
                Vec::new()
            }
        };

        let conv_id = active_map
            .get(&ws)
            .and_then(|opt| opt.as_deref())
            .unwrap_or("");
        let turns: Vec<Value> = if conv_id.is_empty() {
            Vec::new()
        } else {
            match conv_store.read_committed(conv_id, None, 8 * 1024 * 1024) {
                Ok(snap) => {
                    let agent_turns: Vec<&Value> = snap
                        .history
                        .messages
                        .iter()
                        .filter(|m| m.get("kind").and_then(Value::as_str) == Some("agent_turn"))
                        .collect();
                    let start = agent_turns.len().saturating_sub(20);
                    agent_turns[start..]
                        .iter()
                        .map(|m| turn_timing(m))
                        .collect()
                }
                Err(StoreError::NotFound) => Vec::new(),
                Err(_) => {
                    push_unique_code(&mut faults, "TURNS_UNAVAILABLE");
                    Vec::new()
                }
            }
        };

        bots.push(json!({
            "identity": diagnostic_text(Some(&ws)),
            "workspace": ".",
            "lease": lease,
            "input": input,
            "inbox": inbox_val,
            "approvals": approvals,
            "objectives": objectives_val,
            "turns": turns,
            "errors": faults,
        }));
    }

    Ok(json!({
        "ok": true,
        "report": {
            "schemaVersion": 1,
            "generatedAt": now_iso(),
            "scheduler": scheduler,
            "bots": bots,
            "errors": errors,
        }
    }))
}

// ---------------------------------------------------------------------------
// 2. project.bot.continueHistory
// ---------------------------------------------------------------------------

pub fn handle_bot_continue_history(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let conversation_id = params_val
        .get("conversationId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let workspace_id = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if conversation_id.is_empty() || workspace_id.is_empty() {
        return Ok(ok_fail("INVALID_INPUT"));
    }

    let data_home = &ctx.config.data_home;
    let conv_store = ConversationStore::new(data_home);
    let meta = match conv_store.read_metadata(conversation_id) {
        Ok(snap) => match snap.metadata {
            Some(m) => m,
            None => return Ok(ok_fail("NOT_FOUND")),
        },
        Err(StoreError::NotFound | StoreError::InvalidInput) => return Ok(ok_fail("NOT_FOUND")),
        Err(e) => {
            return Ok(json!({
                "ok": false,
                "code": "SNAPSHOT_FAILED",
                "message": e.code(),
            }));
        }
    };

    if meta
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|r| !r.trim().is_empty())
    {
        return Ok(ok_fail("NOT_HISTORY"));
    }
    if meta.get("status").and_then(Value::as_str) == Some("archived") {
        return Ok(ok_fail("ARCHIVED"));
    }

    let captured_at = now_iso();
    let captured = match capture_inherited_background(data_home, conversation_id, &captured_at) {
        Ok(c) => c,
        Err(err) => {
            return Ok(json!({
                "ok": false,
                "code": err.code,
                "message": err.detail,
            }));
        }
    };

    if captured.requires_missing_confirmation
        && params_val.get("confirmMissing").and_then(Value::as_bool) != Some(true)
    {
        return Ok(json!({
            "ok": false,
            "code": "BACKGROUND_CONFIRMATION_REQUIRED",
            "snapshot": { "snapshotId": captured.snapshot_id },
        }));
    }

    let title = meta
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("这段对话");
    let text = params_val
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("继续：{title}"));
    let input_id = params_val
        .get("inputId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let queue = InputQueue::new(data_home);
    match queue.submit_input(&SubmitInputRequest {
        workspace_id,
        input_id: &input_id,
        surface: "desktop",
        text: &text,
        anchor_refs: Vec::new(),
        quote_refs: Vec::new(),
        attachment_refs: Vec::new(),
        attachments: Vec::new(),
        answer_to: None,
        history_ref: Some(conversation_id.to_owned()),
        history_snapshot_id: Some(captured.snapshot_id.clone()),
        history_confirmed: captured.requires_missing_confirmation.then_some(true),
    }) {
        Ok(input) => Ok(json!({
            "ok": true,
            "input": input,
            "snapshot": { "snapshotId": captured.snapshot_id },
        })),
        Err(err) => Ok(json!({
            "ok": false,
            "code": "INVALID_INPUT",
            "message": err.detail,
        })),
    }
}

// ---------------------------------------------------------------------------
// 3 & 4. project.bot.readInputDraft / writeInputDraft
// ---------------------------------------------------------------------------

fn validate_draft_bot_and_surface<'a>(
    data_home: &Path,
    params_val: &'a Value,
) -> Option<(&'a str, &'a str)> {
    let surface = params_val.get("surface").and_then(Value::as_str)?;
    if !matches!(surface, "desktop" | "quick_chat" | "tui") {
        return None;
    }
    let ws = params_val.get("workspaceId").and_then(Value::as_str)?;
    let profile = BotProfileStore::new(data_home).read(ws)?;
    if profile.status == "archived" {
        return None;
    }
    Some((ws, surface))
}

pub fn handle_bot_read_input_draft(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let Some((ws, surface)) = validate_draft_bot_and_surface(&ctx.config.data_home, &params_val)
    else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    match InputDraftStore::new(&ctx.config.data_home).read_hydrated(ws, surface, false) {
        Ok(snapshot) => Ok(json!({ "ok": true, "snapshot": snapshot })),
        Err(err) => Ok(ok_fail(err.code)),
    }
}

pub fn handle_bot_write_input_draft(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    if validate_draft_bot_and_surface(&ctx.config.data_home, &params_val).is_none() {
        return Ok(ok_fail("NOT_FOUND"));
    }
    match InputDraftStore::new(&ctx.config.data_home).write_strict(&params_val) {
        Ok(revision) => Ok(json!({ "ok": true, "revision": revision })),
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 5. project.bot.readEvidence
// ---------------------------------------------------------------------------

fn is_token_ref_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-')
}

fn is_uri_scheme_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')
}

fn is_uri_body_char(b: u8) -> bool {
    b.is_ascii_alphanumeric()
        || matches!(
            b,
            b'.' | b'_'
                | b'~'
                | b':'
                | b'/'
                | b'?'
                | b'#'
                | b'@'
                | b'!'
                | b'$'
                | b'&'
                | b'\''
                | b'('
                | b')'
                | b'*'
                | b'+'
                | b','
                | b';'
                | b'='
                | b'%'
                | b'-'
        )
}

fn evidence_ref_allowed(raw: &Value) -> Option<String> {
    let s = raw.as_str()?.trim();
    if s.is_empty()
        || s.encode_utf16().count() > 500
        || s.contains("..")
        || s.chars()
            .any(|c| c.is_whitespace() || (c as u32) <= 0x1f || c == '\\')
    {
        return None;
    }
    if s.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("file:")) {
        return None;
    }
    let bytes = s.as_bytes();
    let token_ok = bytes.len() <= 200
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|&b| is_token_ref_char(b));
    let uri_ok = if let Some((scheme, rest)) = s.split_once("://") {
        let sb = scheme.as_bytes();
        let rb = rest.as_bytes();
        !sb.is_empty()
            && sb[0].is_ascii_alphabetic()
            && sb[1..].iter().all(|&b| is_uri_scheme_char(b))
            && !rb.is_empty()
            && rb.iter().all(|&b| is_uri_body_char(b))
    } else {
        false
    };
    (token_ok || uri_ok).then(|| s.to_owned())
}

fn is_scope_id(value: &str) -> bool {
    let b = value.as_bytes();
    !b.is_empty()
        && b.len() <= 256
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|&c| is_token_ref_char(c))
        && !value.contains("..")
}

fn evidence_source_description(record: &Value, fallback_ref: &str) -> Value {
    let ev_ref = record
        .get("evidenceRef")
        .and_then(Value::as_str)
        .unwrap_or(fallback_ref);
    let mut obj = serde_json::Map::new();
    obj.insert("evidenceRef".into(), Value::from(ev_ref));
    if let Some(tool_name) = record.get("toolName").and_then(Value::as_str) {
        obj.insert("toolName".into(), Value::from(utf16_slice(tool_name, 120)));
    }
    if let Some(created_at) = record
        .get("createdAt")
        .and_then(Value::as_str)
        .filter(|s| parse_iso_ms(s).is_some())
    {
        obj.insert("createdAt".into(), Value::from(created_at));
    }
    Value::Object(obj)
}

fn present_evidence(
    evidence_ref: &str,
    kind_raw: Option<&str>,
    text: &str,
    truncated_flag: bool,
    availability_opt: Option<&str>,
    source: Option<Value>,
) -> Value {
    let summary: String = text.chars().take(2_000).collect();
    let kind = kind_raw
        .filter(|k| EVIDENCE_KINDS.contains(k))
        .unwrap_or("command");
    let availability = availability_opt.unwrap_or_else(|| {
        if text.trim().is_empty() {
            "metadata_only"
        } else {
            "available"
        }
    });
    let truncated = truncated_flag || text.len() > summary.len();
    let mut out = serde_json::Map::new();
    out.insert("ok".into(), Value::from(availability == "available"));
    out.insert("evidenceRef".into(), Value::from(evidence_ref));
    out.insert("kind".into(), Value::from(kind));
    out.insert("summary".into(), Value::from(summary));
    out.insert("truncated".into(), Value::from(truncated));
    out.insert("availability".into(), Value::from(availability));
    if let Some(src) = source {
        out.insert("source".into(), src);
    }
    if availability == "metadata_only" {
        out.insert("code".into(), Value::from("BODY_NOT_SAVED"));
    } else if availability == "unavailable" {
        out.insert("code".into(), Value::from("READ_FAILED"));
    }
    Value::Object(out)
}

fn kind_from_tool(tool_name: &str) -> &'static str {
    let lower = tool_name.to_ascii_lowercase();
    if lower.contains("screenshot") || lower.contains("image") {
        "screenshot"
    } else if lower.contains("diff") {
        "diff"
    } else {
        "command"
    }
}

fn resolve_artifact_open_path(
    data_home: &Path,
    raw_ref: &str,
    created_at: Option<&str>,
) -> Option<PathBuf> {
    let value = raw_ref.trim();
    let date = created_at
        .filter(|s| s.len() >= 10)
        .map(|s| &s[..10])
        .filter(|d| {
            let b = d.as_bytes();
            b.len() == 10
                && b[4] == b'-'
                && b[7] == b'-'
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[8..10].iter().all(u8::is_ascii_digit)
        })?;
    let (root_dir, rest, is_shell) = if let Some(r) = value.strip_prefix("local-shell-artifact://")
    {
        (data_home.join("shell-artifacts"), r, true)
    } else {
        let r = value.strip_prefix("local-browser-artifact://")?;
        (data_home.join("browser-artifacts"), r, false)
    };
    if rest.is_empty() || rest.contains("..") || rest.contains('\\') || rest.contains('\0') {
        return None;
    }
    let (artifact_id, suffix) = match rest.split_once('/') {
        Some((id, suf)) => (id, Some(suf)),
        None => (rest, None),
    };
    if artifact_id.is_empty() {
        return None;
    }
    let directory = root_dir.join(date).join(artifact_id);
    let target = match suffix {
        None => directory,
        Some(suf) => {
            let file_name = if is_shell {
                match suf {
                    "stdout" => "stdout.txt",
                    "stderr" => "stderr.txt",
                    "metadata" => "metadata.json",
                    _ => return None,
                }
            } else {
                match suf {
                    "screenshot" => "screenshot.png",
                    "content" => "content.txt",
                    "metadata" => "metadata.json",
                    _ => return None,
                }
            };
            directory.join(file_name)
        }
    };
    target.exists().then_some(target)
}

fn read_registered_artifact(data_home: &Path, raw_ref: &str, record: &Value) -> String {
    let Some(target) = resolve_artifact_open_path(
        data_home,
        raw_ref,
        record.get("createdAt").and_then(Value::as_str),
    ) else {
        return String::new();
    };
    let Ok(meta) = fs::metadata(&target) else {
        return String::new();
    };
    if meta.is_dir() {
        return raw_ref.to_owned();
    }
    if target
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "webp" | "gif"
            )
        })
    {
        return raw_ref.to_owned();
    }
    fs::read_to_string(&target).unwrap_or_default()
}

struct EvidenceBody {
    kind: &'static str,
    text: String,
    truncated: bool,
}

fn evidence_body_from_record(data_home: &Path, record: &Value) -> Option<EvidenceBody> {
    if let Some(bp) = record.get("bodyPreview").and_then(Value::as_object)
        && let Some(kind_str) = bp.get("kind").and_then(Value::as_str)
        && let Some(kind) = match kind_str {
            "file" => Some("file"),
            "command" => Some("command"),
            "observation" => Some("observation"),
            _ => None,
        }
        && let Some(text) = bp.get("text").and_then(Value::as_str)
    {
        return Some(EvidenceBody {
            kind,
            text: text.to_owned(),
            truncated: bp.get("truncated").and_then(Value::as_bool) == Some(true),
        });
    }

    let mut chunks: Vec<String> = Vec::new();
    let mut kind = kind_from_tool(record.get("toolName").and_then(Value::as_str).unwrap_or(""));
    if let Some(artifacts) = record.get("userArtifacts").and_then(Value::as_array) {
        for artifact in artifacts {
            let preview = artifact.get("preview").and_then(Value::as_object);
            if let Some(p) = preview
                && p.get("kind").and_then(Value::as_str) == Some("code")
                && let Some(lines) = p.get("diffLines").and_then(Value::as_array)
                && !lines.is_empty()
            {
                kind = "diff";
                let joined = lines
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n");
                chunks.push(joined);
                continue;
            }
            if artifact.get("kind").and_then(Value::as_str) == Some("image")
                || preview.and_then(|p| p.get("kind")).and_then(Value::as_str) == Some("image")
            {
                kind = "screenshot";
                let label = artifact
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        artifact
                            .get("ref")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                    });
                if let Some(l) = label {
                    chunks.push(l.to_owned());
                }
            }
        }
    }
    if let Some(refs) = record.get("artifactRefs").and_then(Value::as_array) {
        for r in refs {
            let Some(ref_str) = r.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            let text = read_registered_artifact(data_home, ref_str, record);
            if text.trim().is_empty() {
                continue;
            }
            let lower_ref = ref_str.to_ascii_lowercase();
            if lower_ref.contains("diff") {
                kind = "diff";
            } else if lower_ref.contains("screenshot")
                || lower_ref.contains("image")
                || lower_ref.contains("png")
                || lower_ref.contains("jpg")
                || lower_ref.contains("jpeg")
                || lower_ref.contains("webp")
            {
                kind = "screenshot";
            }
            chunks.push(text);
        }
    }

    let joined = chunks.join("\n");
    let trimmed = joined.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(EvidenceBody {
        kind,
        text: trimmed.to_owned(),
        truncated: false,
    })
}

fn evidence_body_from_history(
    data_home: &Path,
    record: &Value,
) -> Result<Option<EvidenceBody>, ()> {
    let Some(conv_id) = record
        .get("conversationId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let Some(stream_id) = record
        .get("streamId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    let Some(tool_name) = record
        .get("toolName")
        .and_then(Value::as_str)
        .filter(|t| EVIDENCE_QUERY_TOOLS.contains(t))
    else {
        return Ok(None);
    };
    let expected_cap = format!("local.delegation.{tool_name}");
    if record.get("capabilityId").and_then(Value::as_str) != Some(expected_cap.as_str()) {
        return Ok(None);
    }
    let Some(evidence_ref) = record.get("evidenceRef").and_then(Value::as_str) else {
        return Ok(None);
    };

    let messages =
        match ConversationStore::new(data_home).read_committed(conv_id, None, 8 * 1024 * 1024) {
            Ok(snap) => snap.history.messages,
            Err(StoreError::NotFound) => return Ok(None),
            Err(_) => return Err(()),
        };
    let Some(message) = messages.iter().find(|row| {
        row.get("kind").and_then(Value::as_str) == Some("agent_turn")
            && row
                .get("turnId")
                .or_else(|| row.get("id"))
                .and_then(Value::as_str)
                == Some(stream_id)
    }) else {
        return Ok(None);
    };
    let Some(rounds) = message.get("rounds").and_then(Value::as_array) else {
        return Ok(None);
    };
    for round in rounds {
        let Some(calls) = round.get("toolCalls").and_then(Value::as_array) else {
            continue;
        };
        for call in calls {
            if call.get("name").and_then(Value::as_str) != Some(tool_name) {
                continue;
            }
            let result = &call["result"];
            if result.get("ok").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let has_ref = result
                .get("evidenceRefs")
                .and_then(Value::as_array)
                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(evidence_ref)));
            if !has_ref {
                continue;
            }
            let rows_owned: Vec<&Value> = if tool_name == "list_sessions" {
                let Some(arr) = result.get("sessions").and_then(Value::as_array) else {
                    return Ok(None);
                };
                arr.iter().collect()
            } else {
                let target = result
                    .get("session")
                    .filter(|s| !s.is_null())
                    .unwrap_or(result);
                vec![target]
            };
            let mut chunks: Vec<String> = Vec::new();
            for row in rows_owned.iter().take(20) {
                for candidate in [
                    row.get("title"),
                    row.get("statusLabel"),
                    row.get("report").and_then(|r| r.get("summary")),
                    row.get("summary"),
                ] {
                    if let Some(s) = candidate
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        chunks.push(utf16_slice(s, 4_001).to_owned());
                    }
                }
            }
            let raw = chunks.join("\n");
            if raw.is_empty() {
                return Ok(None);
            }
            let text = utf16_slice(&redact_shell_output(&raw), 4_000).to_owned();
            let truncated = raw.encode_utf16().count() > 4_000 || rows_owned.len() > 20;
            return Ok(Some(EvidenceBody {
                kind: "observation",
                text,
                truncated,
            }));
        }
    }
    Ok(None)
}

fn read_watch_evidence(data_home: &Path, evidence_ref: &str) -> Result<Option<Value>, ()> {
    let Some(rest) = evidence_ref.strip_prefix("objective-probe:") else {
        return Ok(None);
    };
    let Some((ws, digest)) = rest.split_once(':') else {
        return Ok(None);
    };
    if !is_valid_workspace_id(ws)
        || ws.contains("..")
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Ok(None);
    }
    let path = data_home
        .join("project-runtime")
        .join(ws)
        .join("objectives")
        .join("probe-evidence")
        .join(format!("{digest}.json"));
    let raw = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let item: Value = serde_json::from_str(&raw).map_err(|_| ())?;
    if item.get("evidenceRef").and_then(Value::as_str) != Some(evidence_ref) {
        return Err(());
    }
    let Some(item_ws) = item.get("workspaceId").and_then(Value::as_str) else {
        return Err(());
    };
    let Some(exec_key) = item.get("executionKey").and_then(Value::as_str) else {
        return Err(());
    };
    if item_ws != ws || sha256_hex(exec_key.as_bytes()) != digest {
        return Err(());
    }
    Ok(Some(item))
}

fn watch_evidence_body(record: &Value) -> Result<String, ()> {
    let payload = json!({
        "observation": record.get("observation").cloned().unwrap_or(Value::Null),
        "call": record["execution"].get("call").cloned().unwrap_or(Value::Null),
        "grant": record["execution"].get("grant").cloned().unwrap_or(Value::Null),
        "result": record["execution"].get("result").cloned().unwrap_or(Value::Null),
    });
    serde_json::to_string_pretty(&payload).map_err(|_| ())
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hi = char::from(*bytes.get(i + 1)?).to_digit(16)?;
            let lo = char::from(*bytes.get(i + 2)?).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_absolute_platform_path(p: &str) -> bool {
    if p.starts_with('/') {
        return true;
    }
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\')
}

fn artifact_locator(artifact: &Value) -> Option<String> {
    if let Some(declared) = artifact.get("path").and_then(Value::as_str)
        && !declared.is_empty()
        && declared.encode_utf16().count() <= 8192
        && is_absolute_platform_path(declared)
        && !declared.chars().any(|c| (c as u32) <= 0x1f)
    {
        return Some(declared.to_owned());
    }
    let raw_ref = artifact.get("ref").and_then(Value::as_str)?;
    let rest = raw_ref.strip_prefix("file://")?;
    let path_part = if let Some(after_host) = rest.strip_prefix("localhost/") {
        format!("/{after_host}")
    } else if rest.starts_with('/') {
        rest.to_owned()
    } else {
        return None;
    };
    let clean_path = path_part.split(['?', '#']).next().unwrap_or(&path_part);
    let decoded = percent_decode(clean_path)?;
    (decoded.encode_utf16().count() <= 8192 && !decoded.chars().any(|c| (c as u32) <= 0x1f))
        .then_some(decoded)
}

fn looks_like_uuid_or_scheme(s: &str) -> bool {
    if s.contains("://") {
        return true;
    }
    let b = s.as_bytes();
    b.len() >= 36
        && b[8] == b'-'
        && b[..8].iter().all(u8::is_ascii_hexdigit)
        && b[9..].iter().all(|c| c.is_ascii_hexdigit() || *c == b'-')
}

fn valid_data_image_url(url: &str, max_len: usize) -> bool {
    if url.encode_utf16().count() > max_len {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("data:image/png;base64,") {
        r
    } else if let Some(r) = lower.strip_prefix("data:image/jpeg;base64,") {
        r
    } else if let Some(r) = lower.strip_prefix("data:image/webp;base64,") {
        r
    } else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

fn project_deliveries(
    data_home: &Path,
    record: &Value,
    context: &Value,
) -> (&'static str, Vec<Value>) {
    let denied = || ("scope_denied", Vec::new());
    let Some(ctx_obj) = context.as_object() else {
        return denied();
    };
    let Some(ws) = ctx_obj
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| is_scope_id(s))
    else {
        return denied();
    };
    let has_task_key = ctx_obj.contains_key("task");
    let req_task = if has_task_key {
        let Some(t_obj) = ctx_obj.get("task").and_then(Value::as_object) else {
            return denied();
        };
        let Some(sid) = t_obj
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|s| is_scope_id(s))
        else {
            return denied();
        };
        let Some(pid) = t_obj
            .get("planId")
            .and_then(Value::as_str)
            .filter(|s| is_scope_id(s))
        else {
            return denied();
        };
        Some((sid, pid))
    } else {
        None
    };

    let supervisor = SessionSupervisor::new(data_home, None);
    let profiles = BotProfileStore::new(data_home);
    let mut verified_task: Option<(String, String)> = None;

    if let Some(plan_id_val) = record.get("planId").filter(|v| !v.is_null()) {
        let Some(rec_plan_id) = plan_id_val.as_str().filter(|s| is_scope_id(s)) else {
            return denied();
        };
        let Ok(plan) = supervisor.read_plan(rec_plan_id) else {
            return denied();
        };
        if plan.get("planId").and_then(Value::as_str) != Some(rec_plan_id) {
            return denied();
        }
        let origin = &plan["delegationOrigin"];
        if origin.get("workspaceId").and_then(Value::as_str) != Some(ws) {
            return denied();
        }
        let Some(origin_session_id) = origin
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|s| is_scope_id(s))
        else {
            return denied();
        };
        if let Some((req_sid, req_pid)) = req_task
            && (req_sid != origin_session_id || req_pid != rec_plan_id)
        {
            return denied();
        }
        let Some(matched_plan) = supervisor.find_plan_by_session(ws, origin_session_id) else {
            return denied();
        };
        if matched_plan.get("planId").and_then(Value::as_str) != Some(rec_plan_id)
            || matched_plan["delegationOrigin"]["workspaceId"].as_str() != Some(ws)
            || matched_plan["delegationOrigin"]["sessionId"].as_str() != Some(origin_session_id)
        {
            return denied();
        }
        verified_task = Some((origin_session_id.to_owned(), rec_plan_id.to_owned()));
    } else {
        if has_task_key {
            return denied();
        }
        let Some(rec_conv) = record
            .get("conversationId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return denied();
        };
        let bot_conv = profiles
            .read(ws)
            .and_then(|p| p.agent_conversation_id)
            .unwrap_or_default();
        if rec_conv != bot_conv {
            return denied();
        }
    }

    let mut deliveries = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut preview_budget: usize = 512 * 1024;
    let ev_ref = record
        .get("evidenceRef")
        .and_then(Value::as_str)
        .unwrap_or("");

    let Some(user_artifacts) = record.get("userArtifacts").and_then(Value::as_array) else {
        return ("available", deliveries);
    };

    for artifact in user_artifacts {
        if deliveries.len() >= 8 {
            break;
        }
        let Some(art_kind) = artifact.get("kind").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(art_kind, "file" | "code-change" | "image") {
            continue;
        }
        let Some(art_ref) = artifact.get("ref").and_then(Value::as_str).filter(|s| {
            !s.trim().is_empty()
                && s.encode_utf16().count() <= 8192
                && !s.chars().any(|c| (c as u32) <= 0x1f)
        }) else {
            continue;
        };
        if !seen.insert(art_ref.to_owned()) {
            continue;
        }
        let target = artifact_locator(artifact);
        let base_name = target
            .as_deref()
            .and_then(|t| Path::new(t).file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let fallback = if !base_name.is_empty() {
            base_name
        } else {
            match art_kind {
                "file" => "File",
                "code-change" => "Code change",
                _ => "Image",
            }
        };
        let raw_label: String = artifact
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .filter(|c| (*c as u32) > 0x1f)
            .collect();
        let trimmed_label = raw_label.trim();
        let chosen_label = if trimmed_label.is_empty() || looks_like_uuid_or_scheme(trimmed_label) {
            fallback
        } else {
            trimmed_label
        };
        let label = utf16_slice(chosen_label, 160).to_owned();

        let mut delivery = serde_json::Map::new();
        delivery.insert("evidenceRef".into(), Value::from(ev_ref));
        delivery.insert("artifactRef".into(), Value::from(art_ref));
        delivery.insert("kind".into(), Value::from(art_kind));
        delivery.insert("label".into(), Value::from(label));
        if let Some(ref path_target) = target {
            let mut ref_obj = json!({
                "workspaceId": ws,
                "path": path_target,
                "kind": "file",
            });
            if let Some((ref sid, ref pid)) = verified_task {
                ref_obj["task"] = json!({
                    "sessionId": sid,
                    "planId": pid,
                });
            }
            delivery.insert("reference".into(), ref_obj);
        }

        if let Some(preview) = artifact.get("preview").filter(|v| !v.is_null()) {
            let mut saved_preview: Option<Value> = None;
            let p_kind = preview.get("kind").and_then(Value::as_str);
            if matches!(art_kind, "file" | "code-change") && p_kind == Some("code") {
                if let Some(lines) = preview.get("diffLines").and_then(Value::as_array) {
                    let diff_text = lines
                        .iter()
                        .filter_map(Value::as_str)
                        .take(41)
                        .map(|l| utf16_slice(l, 240))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let u16_len = diff_text.encode_utf16().count();
                    if u16_len > 0 && u16_len <= preview_budget {
                        preview_budget -= u16_len;
                        saved_preview = Some(json!({
                            "kind": "diff-summary",
                            "text": diff_text,
                            "truncated": true,
                        }));
                    }
                }
            } else if art_kind == "image"
                && p_kind == Some("image")
                && let Some(data_url) = preview.get("dataUrl").and_then(Value::as_str)
                && let Some(w) = preview.get("width").and_then(Value::as_u64)
                && let Some(h) = preview.get("height").and_then(Value::as_u64)
                && (1..=640).contains(&w)
                && (1..=640).contains(&h)
                && valid_data_image_url(data_url, preview_budget.min(256 * 1024))
            {
                let u16_len = data_url.encode_utf16().count();
                preview_budget -= u16_len;
                saved_preview = Some(json!({
                    "kind": "image",
                    "dataUrl": data_url,
                    "width": w,
                    "height": h,
                }));
            }
            if let Some(sp) = saved_preview {
                delivery.insert("savedPreview".into(), sp);
            } else {
                delivery.insert("previewUnavailable".into(), Value::from(true));
            }
        }

        deliveries.push(Value::Object(delivery));
    }

    ("available", deliveries)
}

fn record_is_interactive(record: &Value) -> bool {
    record
        .get("interactiveInspection")
        .is_some_and(|v| !v.is_null())
        || record
            .get("userArtifacts")
            .and_then(Value::as_array)
            .is_some_and(|arr| {
                arr.iter()
                    .any(|a| a.get("kind").and_then(Value::as_str) == Some("interactive"))
            })
}

pub fn handle_bot_read_evidence(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let data_home = &ctx.config.data_home;
    let obj = params_val.as_object();
    let has_context = obj.is_some_and(|o| o.contains_key("context"));
    let context_val = obj.and_then(|o| o.get("context"));

    if let Some(raw_refs) = obj
        .and_then(|o| o.get("evidenceRefs"))
        .and_then(Value::as_array)
    {
        if obj.is_some_and(|o| o.contains_key("evidenceRef")) || raw_refs.len() > 100 {
            return Ok(ok_fail("INVALID_REF"));
        }
        let mut unique_refs = Vec::new();
        let mut seen = HashSet::new();
        for item in raw_refs {
            let Some(allowed) = evidence_ref_allowed(item) else {
                return Ok(ok_fail("INVALID_REF"));
            };
            if seen.insert(allowed.clone()) {
                unique_refs.push(allowed);
            }
        }
        if unique_refs
            .iter()
            .any(|r| r.starts_with("interactive-result://"))
        {
            return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
        }
        let records = match EvidenceIndexStore::new(data_home).find(&unique_refs, None) {
            Ok(rows) => rows,
            Err(StoreError::EvidenceUnsupported) => {
                return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
            }
            Err(_) => return Ok(ok_fail("READ_FAILED")),
        };
        let by_ref: HashMap<&str, &Value> = records
            .iter()
            .filter_map(|r| Some((r.get("evidenceRef")?.as_str()?, r)))
            .collect();
        let items: Vec<Value> = unique_refs
            .into_iter()
            .map(|r| match by_ref.get(r.as_str()) {
                Some(rec) => evidence_source_description(rec, &r),
                None => json!({ "evidenceRef": r }),
            })
            .collect();
        return Ok(json!({ "ok": true, "items": items }));
    }

    let Some(evidence_ref) = obj
        .and_then(|o| o.get("evidenceRef"))
        .and_then(evidence_ref_allowed)
    else {
        return Ok(ok_fail("INVALID_REF"));
    };
    if evidence_ref.starts_with("interactive-result://") {
        return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
    }

    let record_opt =
        match EvidenceIndexStore::new(data_home).find(std::slice::from_ref(&evidence_ref), None) {
            Ok(rows) => rows.into_iter().next(),
            Err(StoreError::EvidenceUnsupported) => {
                return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
            }
            Err(_) => {
                return Ok(present_evidence(
                    &evidence_ref,
                    None,
                    "",
                    false,
                    Some("unavailable"),
                    None,
                ));
            }
        };

    if let Some(ref rec) = record_opt {
        if has_context && record_is_interactive(rec) {
            return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
        }
        let source = evidence_source_description(rec, &evidence_ref);
        let mut delivery_extra: Option<(&'static str, Vec<Value>)> = None;
        if let Some(ctx_val) = context_val.filter(|_| has_context) {
            let (status, deliveries) = project_deliveries(data_home, rec, ctx_val);
            if status != "available" {
                let mut res =
                    present_evidence(&evidence_ref, None, "", false, Some("unavailable"), None);
                res["deliveryStatus"] = Value::from(status);
                res["deliveries"] = Value::Array(deliveries);
                res["code"] = Value::from(if status == "scope_denied" {
                    "SCOPE_DENIED"
                } else {
                    "READ_FAILED"
                });
                return Ok(res);
            }
            delivery_extra = Some((status, deliveries));
        }

        let body_opt = match evidence_body_from_record(data_home, rec) {
            Some(b) => Some(b),
            None => match evidence_body_from_history(data_home, rec) {
                Ok(b) => b,
                Err(()) => {
                    let mut res = present_evidence(
                        &evidence_ref,
                        None,
                        "",
                        false,
                        Some("unavailable"),
                        Some(source),
                    );
                    if let Some((status, deliveries)) = delivery_extra {
                        res["deliveryStatus"] = Value::from(status);
                        res["deliveries"] = Value::Array(deliveries);
                    }
                    return Ok(res);
                }
            },
        };

        let mut res = if let Some(body) = body_opt {
            present_evidence(
                &evidence_ref,
                Some(body.kind),
                &body.text,
                body.truncated,
                Some("available"),
                Some(source),
            )
        } else {
            let has_art_refs = rec
                .get("artifactRefs")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty());
            let availability = if has_art_refs {
                "unavailable"
            } else {
                "metadata_only"
            };
            present_evidence(
                &evidence_ref,
                None,
                "",
                false,
                Some(availability),
                Some(source),
            )
        };
        if let Some((status, deliveries)) = delivery_extra {
            res["deliveryStatus"] = Value::from(status);
            res["deliveries"] = Value::Array(deliveries);
        }
        return Ok(res);
    }

    // No index record matched; handle interactive alias + watch evidence fallbacks.
    if has_context {
        if let Some(ctx_obj) = context_val.and_then(Value::as_object)
            && ctx_obj.get("task").is_some_and(Value::is_object)
            && evidence_ref.starts_with("tool-result://")
            && let Some(ws) = ctx_obj.get("workspaceId").and_then(Value::as_str)
            && is_scope_id(ws)
            && data_home
                .join("project-runtime")
                .join(ws)
                .join("interactive-results")
                .exists()
        {
            return Ok(ok_fail("INTERACTIVE_EVIDENCE_HOST_REQUIRED"));
        }

        match read_watch_evidence(data_home, &evidence_ref) {
            Ok(Some(watch_rec)) => {
                let ws_ok = context_val
                    .and_then(|c| c.as_object())
                    .filter(|c| !c.contains_key("task"))
                    .and_then(|c| c.get("workspaceId"))
                    .and_then(Value::as_str)
                    .filter(|s| is_scope_id(s))
                    .is_some_and(|ws| {
                        watch_rec.get("workspaceId").and_then(Value::as_str) == Some(ws)
                    });
                if !ws_ok {
                    let mut res =
                        present_evidence(&evidence_ref, None, "", false, Some("unavailable"), None);
                    res["deliveryStatus"] = Value::from("scope_denied");
                    res["deliveries"] = json!([]);
                    res["code"] = Value::from("SCOPE_DENIED");
                    return Ok(res);
                }
                let Ok(full_text) = watch_evidence_body(&watch_rec) else {
                    return Ok(present_evidence(
                        &evidence_ref,
                        None,
                        "",
                        false,
                        Some("unavailable"),
                        None,
                    ));
                };
                let clipped = utf16_slice(&full_text, 64_000);
                let truncated = clipped.len() < full_text.len();
                let mut res = present_evidence(
                    &evidence_ref,
                    Some("text"),
                    clipped,
                    truncated,
                    Some("available"),
                    None,
                );
                res["deliveryStatus"] = Value::from("available");
                res["deliveries"] = json!([]);
                return Ok(res);
            }
            Ok(None) => {
                let mut res =
                    present_evidence(&evidence_ref, None, "", false, Some("not_found"), None);
                res["deliveryStatus"] = Value::from("unavailable");
                return Ok(res);
            }
            Err(()) => {
                return Ok(present_evidence(
                    &evidence_ref,
                    None,
                    "",
                    false,
                    Some("unavailable"),
                    None,
                ));
            }
        }
    }

    match read_watch_evidence(data_home, &evidence_ref) {
        Ok(Some(watch_rec)) => {
            let Ok(full_text) = watch_evidence_body(&watch_rec) else {
                return Ok(present_evidence(
                    &evidence_ref,
                    None,
                    "",
                    false,
                    Some("unavailable"),
                    None,
                ));
            };
            let clipped = utf16_slice(&full_text, 64_000);
            let truncated = clipped.len() < full_text.len();
            Ok(present_evidence(
                &evidence_ref,
                Some("text"),
                clipped,
                truncated,
                Some("available"),
                None,
            ))
        }
        Ok(None) => Ok(json!({
            "ok": false,
            "evidenceRef": evidence_ref,
            "availability": "not_found",
            "code": "NOT_FOUND",
        })),
        Err(()) => Ok(present_evidence(
            &evidence_ref,
            None,
            "",
            false,
            Some("unavailable"),
            None,
        )),
    }
}
