//! One bounded, loopback-only callback listener. No detached browser/listener task.
use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
pub(super) async fn listen(configured: &str) -> Result<(TcpListener, String), &'static str> {
    let raw = if configured.is_empty() {
        "http://127.0.0.1:0/mcp/oauth/callback"
    } else {
        configured
    };
    let url = Url::parse(raw).map_err(|_| "mcp_oauth_redirect_invalid")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("mcp_oauth_redirect_invalid");
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, url.port().unwrap_or(80)))
        .await
        .map_err(|_| "mcp_oauth_callback_unavailable")?;
    let mut redirect = url;
    redirect
        .set_port(Some(
            listener
                .local_addr()
                .map_err(|_| "mcp_oauth_callback_unavailable")?
                .port(),
        ))
        .map_err(|_| "mcp_oauth_redirect_invalid")?;
    Ok((listener, redirect.into()))
}
pub(super) async fn wait(
    listener: TcpListener,
    redirect: &str,
    authorization: &str,
    cancel: &CancellationToken,
) -> Result<zeroize::Zeroizing<String>, &'static str> {
    let expected = Url::parse(redirect).map_err(|_| "mcp_oauth_redirect_invalid")?;
    let authorization = Url::parse(authorization).map_err(|_| "mcp_oauth_url_invalid")?;
    let state = authorization
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .ok_or("mcp_oauth_state_missing")?;
    let wait = async {
        for _ in 0..16 {
            let (mut socket, peer) = listener
                .accept()
                .await
                .map_err(|_| "mcp_oauth_callback_failed")?;
            if !peer.ip().is_loopback() {
                continue;
            }
            let request = async {
                let mut bytes = zeroize::Zeroizing::new(Vec::new());
                while !bytes.ends_with(b"\r\n\r\n") {
                    if bytes.len() >= 8192 {
                        return None;
                    }
                    let mut byte = [0];
                    if socket.read(&mut byte).await.ok()? != 1 {
                        return None;
                    }
                    bytes.push(byte[0]);
                }
                let text = std::str::from_utf8(&bytes).ok()?;
                let mut lines = text.lines();
                let mut first = lines.next()?.split(' ');
                if first.next() != Some("GET") {
                    return None;
                }
                let target = first.next()?;
                if !target.starts_with('/')
                    || target.starts_with("//")
                    || first.next() != Some("HTTP/1.1")
                    || first.next().is_some()
                {
                    return None;
                }
                let hosts = lines
                    .filter_map(|l| l.split_once(':'))
                    .filter(|(k, _)| k.eq_ignore_ascii_case("host"))
                    .map(|(_, v)| v.trim())
                    .collect::<Vec<_>>();
                let expected_host = format!("127.0.0.1:{}", expected.port_or_known_default()?);
                if hosts.as_slice() != [expected_host.as_str()] {
                    return None;
                }
                let callback = expected.join(target).ok()?;
                if callback.origin() != expected.origin()
                    || callback.path() != expected.path()
                    || callback.fragment().is_some()
                {
                    return None;
                }
                let pairs = callback.query_pairs().collect::<Vec<_>>();
                let states = pairs
                    .iter()
                    .filter(|(k, _)| k == "state")
                    .collect::<Vec<_>>();
                if states.len() != 1
                    || states[0].1 != state
                    || pairs.iter().filter(|(k, _)| k == "code").count() != 1
                    || pairs.iter().any(|(k, _)| k == "error")
                {
                    return None;
                }
                Some(callback.to_string())
            };
            let callback = tokio::time::timeout(Duration::from_secs(2), request)
                .await
                .ok()
                .flatten();
            let (status, body) = if callback.is_some() {
                (
                    "200 OK",
                    "Authorization response received. Return to Peer CLI for the verified result.",
                )
            } else {
                ("400 Bad Request", "Invalid authorization callback.")
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                socket.write_all(response.as_bytes()),
            )
            .await;
            if let Some(callback) = callback {
                return Ok(zeroize::Zeroizing::new(callback));
            }
        }
        Err("mcp_oauth_callback_limit")
    };
    bounded(cancel, wait, 300).await?
}
