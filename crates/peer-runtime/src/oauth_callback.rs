//! One bounded loopback HTTP owner shared by native OAuth adapters.
use crate::CancellationToken;
use reqwest::Url;
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
#[derive(Debug, Clone, Copy)]
pub(crate) enum Error {
    Redirect,
    Unavailable,
    State,
    Url,
    Failed,
    Timeout,
    Limit,
    Cancelled,
    Denied,
}
pub(crate) async fn listen(configured: &str) -> Result<(TcpListener, String), Error> {
    let mut redirect = Url::parse(configured).map_err(|_| Error::Redirect)?;
    if redirect.scheme() != "http"
        || !matches!(redirect.host_str(), Some("127.0.0.1" | "localhost"))
        || !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.query().is_some()
        || redirect.fragment().is_some()
    {
        return Err(Error::Redirect);
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, redirect.port().unwrap_or(80)))
        .await
        .map_err(|_| Error::Unavailable)?;
    redirect
        .set_port(Some(
            listener
                .local_addr()
                .map_err(|_| Error::Unavailable)?
                .port(),
        ))
        .map_err(|_| Error::Redirect)?;
    Ok((listener, redirect.into()))
}
pub(crate) async fn wait(
    listener: TcpListener,
    redirect: &str,
    authorization: &str,
    cancel: &CancellationToken,
    timeout: Duration,
    allow_denial: bool,
) -> Result<zeroize::Zeroizing<String>, Error> {
    let expected = Url::parse(redirect).map_err(|_| Error::Redirect)?;
    let authorization = Url::parse(authorization).map_err(|_| Error::Url)?;
    let states = authorization
        .query_pairs()
        .filter(|(k, _)| k == "state")
        .collect::<Vec<_>>();
    if states.len() != 1 || states[0].1.is_empty() {
        return Err(Error::State);
    }
    let state = &states[0].1;
    let wait = async {
        for _ in 0..16 {
            let (mut socket, peer) = listener.accept().await.map_err(|_| Error::Failed)?;
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
                if target.split('?').next() != Some(expected.path()) {
                    return None;
                }
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
                let host = format!(
                    "{}:{}",
                    expected.host_str()?,
                    expected.port_or_known_default()?
                );
                if hosts.as_slice() != [host.as_str()] {
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
                let returned = pairs
                    .iter()
                    .filter(|(k, _)| k == "state")
                    .collect::<Vec<_>>();
                if returned.len() != 1 || returned[0].1 != *state {
                    return None;
                }
                let errors = pairs.iter().filter(|(k, _)| k == "error").count();
                let codes = pairs
                    .iter()
                    .filter(|(k, _)| k == "code")
                    .collect::<Vec<_>>();
                if allow_denial && errors == 1 && codes.is_empty() {
                    return Some(Err(Error::Denied));
                }
                if errors != 0 || codes.len() != 1 || codes[0].1.is_empty() {
                    return None;
                }
                Some(Ok(zeroize::Zeroizing::new(callback.to_string())))
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
            if let Some(result) = callback {
                return result;
            }
        }
        Err(Error::Limit)
    };
    tokio::select! {biased;_=cancel.cancelled()=>Err(Error::Cancelled), result=tokio::time::timeout(timeout,wait)=>result.unwrap_or(Err(Error::Timeout))}
}
