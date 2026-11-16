use peer_protocol::CliExit;
use serde_json::json;
use std::io::{self, Write};
pub fn run(server: &str, refresh: bool) -> io::Result<CliExit> {
    let home =
        peer_protocol::data_home().ok_or_else(|| io::Error::other("data home unavailable"))?;
    let result = crate::cancellation::run(|cancel| async move {
        if refresh {
            peer_runtime::mcp_oauth::refresh(&home, server, &cancel).await
        } else {
            peer_runtime::mcp_oauth::authorize(&home,server,&cancel,|url| {
            writeln!(io::stdout(),"{}",json!({"status":"authorization_required","serverId":server,"authorizationUrl":url,"nextAction":"Open the URL to authorize. Ctrl-C cancels this login."})).map_err(|_|"mcp_oauth_output_failed")
        }).await
        }
    })?;
    match result {
        Ok(()) => {
            writeln!(
                io::stdout(),
                "{}",
                json!({"status":"credential_updated","serverId":server})
            )?;
            Ok(CliExit::Ok)
        }
        Err(code) => {
            writeln!(
                io::stderr(),
                "peer-native: {code}; credential state preserved; an uncertain refresh requires explicit mcp auth"
            )?;
            Ok(if code == "CANCELLED" {
                CliExit::Cancelled
            } else {
                CliExit::Auth
            })
        }
    }
}
