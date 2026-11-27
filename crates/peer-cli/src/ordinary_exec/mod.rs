//! Native ordinary exec composition. CLI parses intent; Runtime owns all facts.
mod args;
pub use args::Options;
pub(crate) use args::parse;
use peer_protocol::{CliExit, LocalAccessLevel};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model_catalog::ExecSelectionErrorKind,
};
use serde_json::{Value, json};
use std::{
    io::{self, IsTerminal, Write},
    path::PathBuf,
    time::{Duration, Instant},
};
pub const HELP: &str = "Usage: peer exec [options] [prompt]\n\nRead a prompt from arguments or stdin and run the native conversation Host.\n\n  --bot                     Send input to the bound workspace Bot and wait for reply\n  --input-id <id>           Idempotent Bot input id (requires --bot)\n  --wait-ms <ms>            Wait budget 1..1800000 ms for Bot reply (requires --bot)\n  --access ask|session|full   This-run policy (default: session); ask requires a TTY\n  --tools file,bash,...      Mode projection intersected with capability allowlist\n  --output-format text|json Final text or structured result (default: text)\n  --provider <id>           This-run configured channel or catalog entry\n  --model <id>              Model id or provider::model; model ids may contain /\n  --effort <level>          This-run supported reasoning effort\n  --mode chat|plan|goal     Existing runtime mode (default: chat)\n  --fast                   ChatGPT/Grok OAuth priority service\n  --workspace <path>        Existing directory; overrides PEER_WORKSPACE_ROOT\n  --image <path>            Attach a local image; may be repeated\n  --max-turns <n>           Positive hard cap; omitted means no implicit cap\n  --                       Treat remaining arguments as prompt text\n\nUse --access full explicitly for trusted tasks requiring unrestricted local actions.\nGrants and Evidence remain mandatory. Runtime completion does not mean task acceptance.";
fn auth_error(code: &str) -> bool {
    if code == peer_runtime::model::ModelError::AUTH_REJECTED {
        return true;
    }
    let c = code.to_ascii_lowercase();
    [
        "credential",
        "oauth",
        "unauthor",
        "401",
        "locked",
        "unconfigured",
        "not_configured",
        "missing_model",
    ]
    .iter()
    .any(|s| c.contains(s))
}
fn exit(code: &str) -> CliExit {
    if code == "CANCELLED" {
        CliExit::Cancelled
    } else if code == "agent_loop_exhausted" {
        CliExit::MaxTurns
    } else if auth_error(code) {
        CliExit::Auth
    } else {
        CliExit::Runtime
    }
}
fn json_output(value: &Value) -> io::Result<String> {
    let encoded = serde_json::to_string(value).map_err(io::Error::other)?;
    Ok(crate::text::escape_json_controls(&encoded))
}
async fn stdin_prompt(cancel: &CancellationToken) -> Result<String, &'static str> {
    #[cfg(unix)]
    {
        let input = io::stdin();
        let mut bytes = vec![];
        loop {
            if cancel.is_cancelled() {
                return Err("CANCELLED");
            }
            let mut poll = [rustix::event::PollFd::new(
                &input,
                rustix::event::PollFlags::IN,
            )];
            let ready = match rustix::event::poll(
                &mut poll,
                Some(&rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                }),
            ) {
                Ok(ready) => ready,
                // A signal may interrupt poll before the watcher publishes
                // cancellation. Let the watcher run before probing stdin again.
                Err(rustix::io::Errno::INTR) => 0,
                Err(_) => return Err("stdin_unavailable"),
            };
            if ready == 0 {
                tokio::select! {biased;_=cancel.cancelled()=>return Err("CANCELLED"),_=tokio::time::sleep(Duration::from_millis(10))=>{}}
                continue;
            }
            let mut chunk = [0u8; 4096];
            let n = match rustix::io::read(&input, &mut chunk) {
                Ok(n) => n,
                Err(rustix::io::Errno::INTR) => continue,
                Err(_) => return Err("stdin_unavailable"),
            };
            if n == 0 {
                break;
            }
            if bytes.len() + n > 1024 * 1024 {
                return Err("prompt_limit");
            }
            bytes.extend_from_slice(&chunk[..n]);
            tokio::task::yield_now().await;
        }
        String::from_utf8(bytes).map_err(|_| "prompt_invalid_utf8")
    }
    #[cfg(windows)]
    {
        use std::io::Read;
        let (tx, mut rx) = tokio::sync::mpsc::channel::<io::Result<Vec<u8>>>(8);
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            let mut buf = [0u8; 4096];
            loop {
                match input.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(Ok(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => {
                        let _ = tx.blocking_send(Err(e));
                        break;
                    }
                }
            }
        });
        let mut bytes = Vec::new();
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("CANCELLED"),
                next = rx.recv() => next,
            };
            let Some(chunk) = chunk else {
                break;
            };
            let chunk = chunk.map_err(|_| "stdin_unavailable")?;
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("prompt_limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        String::from_utf8(bytes).map_err(|_| "prompt_invalid_utf8")
    }
}
pub fn run(options: &Options) -> io::Result<CliExit> {
    let started = Instant::now();
    if options.access == "ask" && !io::stdin().is_terminal() {
        writeln!(
            io::stderr(),
            "peer exec: --access ask cannot wait for approval without a TTY"
        )?;
        return Ok(CliExit::Usage);
    }
    let allowlist = match args::tools(options.tools.as_deref()) {
        Ok(ids) => ids,
        Err(e) => {
            writeln!(io::stderr(), "{}", peer_tui::terminal_text(&e))?;
            return Ok(CliExit::Usage);
        }
    };
    let workspace = options
        .workspace
        .as_ref()
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("PEER_WORKSPACE_ROOT").map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok());
    let Some(workspace) = workspace.filter(|p| p.is_dir()) else {
        writeln!(
            io::stderr(),
            "peer exec: workspace must be an existing directory"
        )?;
        return Ok(CliExit::Usage);
    };
    let prompt = options
        .prompt_parts
        .iter()
        .filter(|s| s.as_str() != "-")
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");
    let stdin_is_terminal = io::stdin().is_terminal();
    let read = options.prompt_parts == ["-"]
        || options.prompt_parts.is_empty()
            && (options.image_paths.is_empty() || !stdin_is_terminal);
    if read && stdin_is_terminal {
        writeln!(
            io::stderr(),
            "peer exec: prompt is required (pass arguments or pipe stdin)"
        )?;
        return Ok(CliExit::Usage);
    }
    let Some(home) = peer_protocol::data_home() else {
        return Err(io::Error::other("data home unavailable"));
    };
    crate::cancellation::run(|cancel| async move {
        let input = if read {
            match stdin_prompt(&cancel).await {
                Ok(v) => v,
                Err(code) => {
                    let _ = writeln!(io::stderr(), "peer exec: {code}");
                    return Ok(if code == "CANCELLED" {
                        CliExit::Cancelled
                    } else {
                        CliExit::Usage
                    });
                }
            }
        } else {
            prompt
        };
        let prompt = peer_protocol::javascript_trim(&input);
        if prompt.is_empty() && options.image_paths.is_empty() {
            writeln!(
                io::stderr(),
                "peer exec: prompt is required (pass arguments or pipe stdin)"
            )?;
            return Ok(CliExit::Usage);
        }
        if let Some(ref bot_opts) = options.bot {
            return crate::bot_exec::run(
                &home,
                &workspace,
                prompt,
                bot_opts,
                &options.output_format,
                started,
                &cancel,
            )
            .await;
        }
        let selected = match peer_runtime::model_catalog::resolve_exec(
            &home,
            options.provider.as_deref(),
            options.model.as_deref(),
            options.effort.as_deref(),
            options.fast,
        ) {
            Ok(s) => s,
            Err(e) => {
                writeln!(
                    io::stderr(),
                    "peer exec: {}",
                    peer_tui::terminal_text(&e.detail)
                )?;
                return Ok(match e.kind {
                    ExecSelectionErrorKind::ConfigurationUnavailable => CliExit::Auth,
                    ExecSelectionErrorKind::InvalidSelection => CliExit::Usage,
                });
            }
        };
        let model =
            match peer_runtime::model_config::load_model(&home, &selected.selection, &cancel).await
            {
                Ok(m) => m,
                Err(e) => {
                    writeln!(io::stderr(), "peer exec: {}", e.code)?;
                    return Ok(if cancel.is_cancelled() || e.code == "CANCELLED" {
                        CliExit::Cancelled
                    } else {
                        CliExit::Auth
                    });
                }
            };
        let access = match options.access.as_str() {
            "ask" => LocalAccessLevel::AskBeforeLocal,
            "full" => LocalAccessLevel::FullLocal,
            _ => LocalAccessLevel::SessionLocal,
        };
        let runtime = NativeConversationRuntime::new(&home, ConversationAccess::new(access));
        let mode = options
            .mode
            .parse()
            .map_err(|_| io::Error::other("runtime_mode_invalid"))?;
        let run = runtime
            .execute(
                &ConversationOptions {
                    workspace: &workspace,
                    conversation_id: None,
                    resume_from: None,
                    prompt,
                    image_paths: &options.image_paths,
                    provider_id: &selected.entry.provider_id,
                    mode,
                    effort: selected.selection["reasoningEffort"]
                        .as_str()
                        .unwrap_or("default"),
                    persist_model_selection: false,
                    allowlist: allowlist.as_deref(),
                    max_turns: options.max_turns,
                },
                &model,
                &mut crate::native_exec::TerminalPermission,
                &cancel,
            )
            .await;
        match run {
            Ok(outcome) => {
                let code = outcome
                    .error
                    .map(exit)
                    .unwrap_or_else(|| match outcome.goal.as_ref() {
                        None => CliExit::Ok,
                        Some(goal) => match goal["runnerStatus"].as_str() {
                            Some("completed") => CliExit::Ok,
                            Some("failed") => CliExit::GoalFailed,
                            Some("budget_exhausted") => CliExit::MaxTurns,
                            _ => CliExit::WaitingUser,
                        },
                    });
                let stdout = if options.output_format == "json" {
                    let result = (outcome.error.is_none() && !outcome.content.is_empty())
                        .then_some(outcome.content);
                    let mut payload = json!({"sessionId":outcome.session_id,"ok":outcome.error.is_none(),"result":result,"error":outcome.error,"turns":outcome.turns,"durationMs":started.elapsed().as_millis(),"usage":outcome.usage.turn_total});
                    if let Some(goal) = outcome.goal {
                        payload["goal"] = goal;
                    }
                    writeln!(io::stdout(), "{}", json_output(&payload)?)
                } else if let Some(error) = outcome.error {
                    writeln!(io::stderr(), "peer exec: {error}")?;
                    Ok(())
                } else {
                    writeln!(
                        io::stdout(),
                        "{}",
                        peer_tui::terminal_text(&outcome.content)
                    )
                };
                crate::finish_stdout(stdout)?;
                Ok(code)
            }
            Err(error) => {
                writeln!(io::stderr(), "peer exec: {}", error.0)?;
                Ok(exit(error.0))
            }
        }
    })?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_keeps_exact_data_but_cannot_emit_terminal_controls_or_bidi() {
        let value = json!({"result":"line\n\u{1b}]52;c;secret\u{7}\u{202e}reverse"});
        let encoded = json_output(&value).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&encoded).unwrap(), value);
        assert!(!encoded.chars().any(|c| c.is_control() || c == '\u{202e}'));
    }
}
