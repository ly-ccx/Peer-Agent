//! Native `peer bots --json` machine-readable Bot roster listing (ADR 80, ADR 122, ADR 129, ADR 133).

use peer_core_rpc::{DaemonClient, read_daemon_descriptor};
use peer_project_agent::{NativeProjectHost, bot_list_json};
use peer_protocol::{CliExit, data_home};
use serde_json::{Value, json};
use std::{
    io::{self, Write},
    path::Path,
    time::Duration,
};

const DAEMON_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

fn env_truthy(key: &str) -> bool {
    std::env::var(key).ok().is_some_and(|raw| {
        matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        )
    })
}

fn try_list_via_daemon(data_home: &Path) -> Option<Value> {
    let descriptor = read_daemon_descriptor(data_home).ok().flatten()?;
    crate::cancellation::run(|_| async move {
        tokio::time::timeout(DAEMON_QUERY_TIMEOUT, async {
            let mut client = DaemonClient::connect_descriptor(
                &descriptor,
                "peer-cli",
                crate::VERSION.trim(),
                vec![],
            )
            .await?;
            let response = client.request("project.bot.list", json!({})).await?;
            let _ = client.disconnect().await;
            match response {
                Ok(val) if val.get("ok").and_then(Value::as_bool) == Some(true) => val
                    .get("items")
                    .filter(|v| v.is_array())
                    .cloned()
                    .ok_or_else(|| {
                        io::Error::new(io::ErrorKind::InvalidData, "missing project.bot.list items")
                    }),
                Ok(_) | Err(_) => Err(io::Error::other("project.bot.list failed")),
            }
        })
        .await
        .ok()
        .and_then(Result::ok)
    })
    .ok()
    .flatten()
}

pub fn list_json(standalone: bool) -> io::Result<CliExit> {
    let Some(home) = data_home() else {
        writeln!(io::stderr(), "peer bots: data home unavailable")?;
        return Ok(CliExit::Runtime);
    };
    let force_standalone = standalone || env_truthy("PEER_STANDALONE");
    let payload = if !force_standalone && let Some(items) = try_list_via_daemon(&home) {
        items
    } else {
        let host = match NativeProjectHost::new(&home, crate::VERSION.trim(), None) {
            Ok(h) => h,
            Err(err) => {
                writeln!(io::stderr(), "peer bots: {}", err.code)?;
                return Ok(CliExit::Runtime);
            }
        };
        let payload = bot_list_json(&host);
        host.close();
        payload
    };
    let encoded = serde_json::to_string(&payload).map_err(io::Error::other)?;
    crate::finish_stdout(writeln!(
        io::stdout(),
        "{}",
        crate::text::escape_json_controls(&encoded)
    ))?;
    Ok(CliExit::Ok)
}
