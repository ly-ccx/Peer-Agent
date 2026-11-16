//! MCP keeps its original IP-literal redirect and stable error contract.
use super::*;
use crate::oauth_callback::{self, Error};
use tokio::net::TcpListener;
fn code(error: Error) -> &'static str {
    match error {
        Error::Redirect => "mcp_oauth_redirect_invalid",
        Error::Unavailable => "mcp_oauth_callback_unavailable",
        Error::State => "mcp_oauth_state_missing",
        Error::Url => "mcp_oauth_url_invalid",
        Error::Failed => "mcp_oauth_callback_failed",
        Error::Timeout => "mcp_oauth_timeout",
        Error::Limit => "mcp_oauth_callback_limit",
        Error::Cancelled => "CANCELLED",
        Error::Denied => "mcp_oauth_denied",
    }
}
pub(super) async fn listen(configured: &str) -> Result<(TcpListener, String), &'static str> {
    let raw = if configured.is_empty() {
        "http://127.0.0.1:0/mcp/oauth/callback"
    } else {
        configured
    };
    let url = Url::parse(raw).map_err(|_| "mcp_oauth_redirect_invalid")?;
    if url.host_str() != Some("127.0.0.1") {
        return Err("mcp_oauth_redirect_invalid");
    }
    oauth_callback::listen(raw).await.map_err(code)
}
pub(super) async fn wait(
    listener: TcpListener,
    redirect: &str,
    authorization: &str,
    cancel: &CancellationToken,
) -> Result<zeroize::Zeroizing<String>, &'static str> {
    oauth_callback::wait(
        listener,
        redirect,
        authorization,
        cancel,
        Duration::from_secs(300),
        false,
    )
    .await
    .map_err(code)
}
