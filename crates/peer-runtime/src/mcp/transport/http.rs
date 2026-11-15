//! Streamable HTTP and the distinct legacy endpoint-event SSE transport.
use super::*;
use reqwest::{
    Client, Url,
    header::{HeaderMap, HeaderName, HeaderValue},
};
use rmcp::service::RxJsonRpcMessage;
use tokio::sync::oneshot;
fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}
pub(super) async fn open(
    config: &Value,
    requests: mpsc::Receiver<Vec<u8>>,
    incoming: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
    cancel: CancellationToken,
    state: Arc<McpState>,
) -> Result<tokio::task::JoinHandle<()>, &'static str> {
    let raw = config["url"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| config["serverUrl"].as_str())
        .ok_or("mcp_url_invalid")?;
    let url = Url::parse(raw).map_err(|_| "mcp_url_invalid")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("mcp_url_invalid");
    }
    let mut headers = HeaderMap::new();
    if let Some(values) = config["headers"].as_object() {
        for (k, v) in values {
            headers.insert(
                HeaderName::from_bytes(k.as_bytes()).map_err(|_| "mcp_header_invalid")?,
                HeaderValue::from_str(v.as_str().ok_or("mcp_header_invalid")?)
                    .map_err(|_| "mcp_header_invalid")?,
            );
        }
    }
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .default_headers(headers)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "mcp_transport_unavailable")?;
    let legacy = config["transport"] == "sse";
    Ok(tokio::spawn(async move {
        let operation = async {
            if legacy {
                let (response_tx, response_rx) = oneshot::channel();
                let response = client
                    .get(url.clone())
                    .header("accept", "text/event-stream")
                    .send()
                    .await
                    .map_err(|_| "mcp_connect_failed")?;
                if !response.status().is_success() {
                    return Err("mcp_http_rejected");
                }
                let read = sse(
                    response,
                    &state,
                    incoming.clone(),
                    Some((url.clone(), response_tx)),
                    None,
                );
                let write = async {
                    let endpoint = response_rx.await.map_err(|_| "mcp_endpoint_missing")?;
                    post(client, url, endpoint, requests, incoming, &state, true).await
                };
                tokio::select! {v=read=>v,v=write=>v}
            } else {
                post(client, url.clone(), url, requests, incoming, &state, false).await
            }
        };
        let result = tokio::select! {biased;_=cancel.cancelled()=>Ok(()),v=operation=>v};
        state.fail(result.err().unwrap_or("mcp_connection_closed"));
    }))
}
// A primary SSE response and one SDK control POST can coexist. Both futures
// stay inside the registered worker; cancellation drops them together.
struct HttpPosts {
    client: Client,
    endpoint: Url,
    session: Option<String>,
}
impl HttpPosts {
    async fn send(
        &mut self,
        bytes: Vec<u8>,
        state: &Arc<McpState>,
    ) -> Result<reqwest::Response, &'static str> {
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "mcp_request_invalid")?;
        let mut request = self
            .client
            .post(self.endpoint.clone())
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(bytes);
        if let Some(id) = &self.session {
            request = request.header("mcp-session-id", id);
        }
        if let Some(version) = state.inner.lock().unwrap().protocol.clone() {
            request = request.header("mcp-protocol-version", version);
        }
        if value["method"] == "tools/call" {
            state.sent.store(true, Ordering::Release);
        }
        let response = request.send().await.map_err(|_| "mcp_connect_failed")?;
        if !response.status().is_success() {
            return Err("mcp_http_rejected");
        }
        if let Some(id) = response.headers().get("mcp-session-id") {
            let id = id
                .to_str()
                .ok()
                .filter(|s| {
                    !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
                })
                .ok_or("mcp_session_invalid")?;
            if self.session.as_ref().is_some_and(|old| old != id) {
                return Err("mcp_session_changed");
            }
            self.session = Some(id.into());
        }
        Ok(response)
    }
}
async fn post(
    client: Client,
    _base: Url,
    endpoint: Url,
    mut requests: mpsc::Receiver<Vec<u8>>,
    incoming: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
    state: &Arc<McpState>,
    legacy: bool,
) -> Result<(), &'static str> {
    let mut posts = HttpPosts {
        client,
        endpoint,
        session: None,
    };
    while let Some(bytes) = requests.recv().await {
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "mcp_request_invalid")?;
        let mut response = posts.send(bytes, state).await?;
        if legacy || response.status() == 202 {
            continue;
        }
        let kind = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("");
        if kind == "text/event-stream" {
            let receive = sse(response, state, incoming.clone(), None, Some(&value["id"]));
            tokio::pin!(receive);
            loop {
                tokio::select! {biased;
                    outcome=&mut receive=>{outcome?;break},
                    bytes=requests.recv()=>{
                        let bytes=bytes.ok_or("mcp_connection_closed")?;
                        let control:Value=serde_json::from_slice(&bytes).map_err(|_|"mcp_request_invalid")?;
                        let reply=!control["id"].is_null() && control.get("method").is_none() && (control.get("result").is_some() || control.get("error").is_some());
                        let notification=control["id"].is_null() && control["method"].as_str().is_some_and(|m|m.starts_with("notifications/"));
                        if !reply && !notification{return Err("mcp_interleaved_request")}
                        let response=posts.send(bytes,state).await?;
                        if response.status()!=202{return Err("mcp_control_rejected")}
                    }
                }
            }
        } else if kind == "application/json" {
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "mcp_read_failed")? {
                if body.len() + chunk.len() > LIMITS["maxFrameBytes"].as_u64().unwrap() as usize {
                    return Err("mcp_message_limit");
                }
                body.extend_from_slice(&chunk);
            }
            incoming
                .send(state.incoming(&body)?)
                .await
                .map_err(|_| "mcp_connection_closed")?;
        } else {
            return Err("mcp_content_type_invalid");
        }
    }
    Err("mcp_connection_closed")
}
async fn sse(
    mut response: reqwest::Response,
    state: &Arc<McpState>,
    incoming: mpsc::Sender<RxJsonRpcMessage<RoleClient>>,
    mut endpoint: Option<(Url, oneshot::Sender<Url>)>,
    until: Option<&Value>,
) -> Result<(), &'static str> {
    let mut buffer = Vec::new();
    let mut event = String::new();
    let mut data = String::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "mcp_read_failed")? {
        for b in chunk {
            if b != b'\n' {
                if buffer.len() >= LIMITS["maxFrameBytes"].as_u64().unwrap() as usize {
                    return Err("mcp_message_limit");
                }
                buffer.push(b);
                continue;
            }
            let line = std::str::from_utf8(&buffer)
                .map_err(|_| "mcp_message_invalid")?
                .trim_end_matches('\r');
            if line.is_empty() {
                if event == "endpoint" {
                    let (base, sender) = endpoint.take().ok_or("mcp_endpoint_invalid")?;
                    let target = base.join(&data).map_err(|_| "mcp_endpoint_invalid")?;
                    if !same_origin(&base, &target) {
                        return Err("mcp_endpoint_origin_invalid");
                    }
                    let _ = sender.send(target);
                } else if !data.is_empty() {
                    let message = state.incoming(data.as_bytes())?;
                    let raw: Value =
                        serde_json::from_str(&data).map_err(|_| "mcp_message_invalid")?;
                    let complete = until.is_some_and(|id| {
                        !id.is_null()
                            && raw["id"] == *id
                            && raw.get("method").is_none()
                            && (raw.get("result").is_some() || raw.get("error").is_some())
                    });
                    incoming
                        .send(message)
                        .await
                        .map_err(|_| "mcp_connection_closed")?;
                    if complete {
                        return Ok(());
                    }
                }
                data.clear();
                event.clear();
            } else if let Some(value) = line.strip_prefix("event:") {
                event = value.trim_start_matches(' ').into();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n')
                }
                data.push_str(value.strip_prefix(' ').unwrap_or(value));
                if data.len() > LIMITS["maxFrameBytes"].as_u64().unwrap() as usize {
                    return Err("mcp_message_limit");
                }
            }
            buffer.clear();
        }
    }
    if endpoint.is_some() {
        Err("mcp_endpoint_missing")
    } else {
        Ok(())
    }
}
