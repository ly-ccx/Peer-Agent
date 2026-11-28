//! Native `peer exec --bot` execution path (ADR 80, ADR 85, ADR 88, ADR 129–131).
//!
//! Mirrors `apps/tui/src/cli-exec-bot.ts`: submits durable input to the bound
//! workspace Bot's `InputQueue`, drives native `NativeProjectHost::tick` when
//! this host acquires the lease (or waits cleanly as a client when another host
//! holds the lease), enforces owner-change checks, reads any cited fixed
//! interactive results, and formats identical text/JSON output and exit codes.

use peer_project_agent::{BotProfile, LeaseStatus, NativeProjectHost};
use peer_protocol::{CliExit, interactive_result::InteractiveResultReference};
use peer_runtime::CancellationToken;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotExecOptions {
    pub input_id: Option<String>,
    pub wait_ms: u64,
}

fn json_output(value: &Value) -> io::Result<String> {
    let encoded = serde_json::to_string(value).map_err(io::Error::other)?;
    Ok(crate::text::escape_json_controls(&encoded))
}

fn is_current_owner(
    host: &NativeProjectHost,
    workspace_id: &str,
    expected_conversation_id: Option<&str>,
) -> bool {
    let Some(expected) = expected_conversation_id else {
        return false;
    };
    host.profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .and_then(|p| p.agent_conversation_id)
        .is_some_and(|cid| cid == expected)
}

pub async fn run(
    home: &Path,
    workspace: &Path,
    prompt: &str,
    bot_opts: &BotExecOptions,
    output_format: &str,
    started: Instant,
    cancel: &CancellationToken,
) -> io::Result<CliExit> {
    let host = match NativeProjectHost::new(home, crate::VERSION.trim(), None) {
        Ok(h) => h,
        Err(_) => {
            return emit_result(
                output_format,
                "",
                CliExit::Runtime,
                None,
                Some("bot_exec_unavailable"),
                None,
                &[],
                started,
            );
        }
    };

    let bound_entry = host
        .registry()
        .find_by_path(&workspace.to_string_lossy())
        .ok()
        .flatten();
    let workspace_id = bound_entry
        .as_ref()
        .map(|e| e.workspace_id.clone())
        .unwrap_or_default();
    let initial_profile = if workspace_id.is_empty() {
        None
    } else {
        host.profiles()
            .read(&workspace_id)
            .filter(BotProfile::is_active)
    };
    let initial_conv_id = initial_profile
        .as_ref()
        .and_then(|p| p.agent_conversation_id.clone());

    let input_id = bot_opts
        .input_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let mut receipt: Option<Value> = None;
    let mut result_text: Option<String> = None;
    let mut error_code: Option<&'static str> = None;
    let mut interactive_results: Vec<Value> = Vec::new();
    let mut code = CliExit::Runtime;

    if initial_profile.is_none()
        || !is_current_owner(&host, &workspace_id, initial_conv_id.as_deref())
    {
        error_code = Some("bot_not_bound");
        code = CliExit::Usage;
    } else {
        let conv_id = initial_conv_id.as_deref().unwrap_or("");
        receipt = Some(json!({ "inputId": input_id, "status": "unknown" }));
        match host.submit_user_input(&workspace_id, &input_id, prompt, None) {
            Ok(saved) => {
                if saved.workspace_id != workspace_id
                    || saved.input_id != input_id
                    || saved.surface != "tui"
                    || saved.text != prompt
                {
                    error_code = Some("bot_input_conflict");
                    code = CliExit::Runtime;
                } else {
                    receipt = Some(json!({ "inputId": input_id, "status": "received" }));
                    // Lazily resolve model only if we actually acquire the lease and need to run turns.
                    let mut cached_model: Option<(peer_runtime::model::NativeModel, Value)> = None;
                    let mut model_unavailable = false;
                    let deadline = Instant::now() + Duration::from_millis(bot_opts.wait_ms);

                    while is_current_owner(&host, &workspace_id, Some(conv_id))
                        && !cancel.is_cancelled()
                    {
                        if let Ok(Some(reply)) = host.find_reply_for_input(&workspace_id, &input_id)
                            && let Some(reply_id) = reply["id"].as_str()
                        {
                            if !is_current_owner(&host, &workspace_id, Some(conv_id)) {
                                break;
                            }
                            receipt = Some(json!({
                                "inputId": input_id,
                                "status": "replied",
                                "replyId": reply_id,
                            }));
                            let cleaned =
                                peer_tui::terminal_text(reply["content"].as_str().unwrap_or(""));
                            result_text = (!cleaned.is_empty()).then_some(cleaned);

                            if let Some(refs) = reply["meta"]["evidenceRefs"].as_array() {
                                let mut seen = HashSet::new();
                                for r in refs.iter().filter_map(Value::as_str) {
                                    if seen.len() >= 20 {
                                        break;
                                    }
                                    if !seen.insert(r) {
                                        continue;
                                    }
                                    let Some(reference) = InteractiveResultReference::parse(r)
                                    else {
                                        continue;
                                    };
                                    if reference.owner.workspace_id != workspace_id
                                        || reference.owner.conversation_id != conv_id
                                    {
                                        continue;
                                    }
                                    if let Ok(mut summary) =
                                        peer_store::read_interactive_result(home, &reference)
                                    {
                                        crate::text::strip_terminal_controls(&mut summary.title);
                                        crate::text::strip_terminal_controls(
                                            &mut summary.text_fallback.text,
                                        );
                                        if let Ok(v) = serde_json::to_value(&summary) {
                                            interactive_results.push(v);
                                        }
                                    }
                                }
                            }
                            code = CliExit::Ok;
                            break;
                        }

                        if Instant::now() >= deadline {
                            break;
                        }

                        // Attempt host tick if we hold or can acquire the workspace lease.
                        if !model_unavailable
                            && matches!(
                                host.ensure_lease(&workspace_id),
                                Ok(LeaseStatus::Acquired { .. })
                            )
                        {
                            if cached_model.is_none() {
                                match peer_runtime::model_catalog::resolve_exec(
                                    home, None, None, None, false,
                                ) {
                                    Ok(selected) => {
                                        match peer_runtime::model_config::load_model(
                                            home,
                                            &selected.selection,
                                            cancel,
                                        )
                                        .await
                                        {
                                            Ok(m) => {
                                                cached_model = Some((m, selected.selection));
                                            }
                                            Err(_) => {
                                                model_unavailable = true;
                                            }
                                        }
                                    }
                                    Err(_) => {
                                        model_unavailable = true;
                                    }
                                }
                            }
                            if let Some((ref model, ref selection)) = cached_model {
                                let mut perm = crate::native_exec::TerminalPermission;
                                let _ = host
                                    .tick(
                                        &workspace_id,
                                        model,
                                        selection.clone(),
                                        &mut perm,
                                        cancel,
                                    )
                                    .await;
                                continue;
                            }
                        }

                        let remaining = deadline.saturating_duration_since(Instant::now());
                        let step = remaining.min(Duration::from_millis(250));
                        tokio::select! {
                            biased;
                            _ = cancel.cancelled() => break,
                            _ = tokio::time::sleep(step) => {}
                        }
                    }

                    if !is_current_owner(&host, &workspace_id, Some(conv_id)) {
                        result_text = None;
                        interactive_results.clear();
                        error_code = Some("bot_owner_changed");
                        code = CliExit::Auth;
                    } else if code != CliExit::Ok {
                        if cancel.is_cancelled() {
                            error_code = Some("bot_wait_cancelled");
                            code = CliExit::Cancelled;
                        } else {
                            error_code = Some("bot_reply_pending");
                            code = CliExit::BotReplyPending;
                        }
                    }
                }
            }
            Err(err) => {
                error_code = if err.code == "INPUT_CONFLICT" {
                    Some("bot_input_conflict")
                } else {
                    Some("bot_exec_unavailable")
                };
                code = CliExit::Runtime;
            }
        }
    }

    host.close();

    if receipt.as_ref().is_some_and(|r| r["status"] == "replied")
        && !is_current_owner(&host, &workspace_id, initial_conv_id.as_deref())
    {
        result_text = None;
        interactive_results.clear();
        error_code = Some("bot_owner_changed");
        code = CliExit::Auth;
    }

    emit_result(
        output_format,
        initial_conv_id.as_deref().unwrap_or(""),
        code,
        result_text.as_deref(),
        error_code,
        receipt.as_ref(),
        &interactive_results,
        started,
    )
}

#[allow(clippy::too_many_arguments)]
fn emit_result(
    output_format: &str,
    session_id: &str,
    code: CliExit,
    result: Option<&str>,
    error: Option<&str>,
    receipt: Option<&Value>,
    interactive_results: &[Value],
    started: Instant,
) -> io::Result<CliExit> {
    if output_format == "json" {
        let mut payload = json!({
            "sessionId": session_id,
            "ok": code == CliExit::Ok,
            "result": result,
            "error": error,
            "turns": 0,
            "durationMs": started.elapsed().as_millis(),
        });
        if let Some(r) = receipt {
            payload["botInput"] = r.clone();
        }
        if !interactive_results.is_empty() {
            payload["interactiveResults"] = json!(interactive_results);
        }
        crate::finish_stdout(writeln!(io::stdout(), "{}", json_output(&payload)?))?;
    } else {
        if let Some(text) = result {
            crate::finish_stdout(writeln!(io::stdout(), "{text}"))?;
        }
        for item in interactive_results {
            let title = item["title"].as_str().unwrap_or("");
            let locator = item["ref"].as_str().unwrap_or("");
            let availability = item["availability"].as_str().unwrap_or("");
            let truncated = if item["truncated"] == true {
                " (truncated)"
            } else {
                ""
            };
            let fallback = item["textFallback"]["text"]
                .as_str()
                .or_else(|| item["textFallback"].as_str())
                .unwrap_or("");
            crate::finish_stdout(writeln!(
                io::stdout(),
                "\n{title}\n{locator}\nAvailability: {availability}\nSaved model summary, unverified{truncated}\n{fallback}"
            ))?;
        }
        if let Some(err) = error {
            let suffix = receipt
                .and_then(|r| {
                    let id = r["inputId"].as_str()?;
                    let st = r["status"].as_str()?;
                    Some(format!(" (input {id}, {st})"))
                })
                .unwrap_or_default();
            writeln!(io::stderr(), "peer exec: {err}{suffix}")?;
        }
    }
    Ok(code)
}
