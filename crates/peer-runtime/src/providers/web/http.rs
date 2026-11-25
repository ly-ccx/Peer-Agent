use super::*;
use crate::network::Network;
use reqwest::Url;
use std::future::Future;
use zeroize::Zeroizing;
pub(super) struct Fetched {
    pub requested: String,
    pub final_url: String,
    pub mime: String,
    pub status: u16,
    pub started_at: String,
    pub bytes: Vec<u8>,
    pub secrets: Zeroizing<Vec<String>>,
}
pub(super) struct Failure {
    code: &'static str,
    status: Option<u16>,
    final_url: Option<String>,
    redacted: bool,
    dispatched: bool,
}
impl Failure {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            status: None,
            final_url: None,
            redacted: false,
            dispatched: false,
        }
    }
    pub fn outcome(self) -> EffectOutcome {
        let mut out = EffectOutcome::failed(self.code);
        out.not_dispatched = !self.dispatched;
        out.status = match self.code {
            "CANCELLED" => "cancelled",
            _ => "failed",
        };
        out.output = json!({"fetchMode":"failed"});
        if self.redacted {
            out.output["redacted"] = json!(true);
        }
        if let Some(n) = self.status {
            out.output["httpStatus"] = json!(n);
            if self.code == "web_http_error" {
                out.output["errorDetail"] = json!(format!("http_{n}"));
            }
        }
        if let Some(url) = self.final_url {
            out.output["finalUrl"] = json!(url);
        }
        out
    }
}
pub(super) fn normalize(raw: &str, base: Option<&Url>) -> Result<Url, &'static str> {
    let raw = peer_protocol::javascript_trim(raw);
    if raw.is_empty() {
        return Err("invalid_url");
    };
    if raw.len() > 16384 {
        return Err("web_url_limit");
    };
    let url = match base {
        Some(base) => base.join(raw),
        None => Url::parse(raw),
    }
    .map_err(|_| "invalid_url")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("unsupported_protocol");
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err("web_url_credentials");
    };
    if url.as_str().len() > 16384 {
        return Err("web_url_limit");
    }
    if url.host_str().is_none() {
        return Err("invalid_url");
    };
    Ok(url)
}
pub(super) async fn wait<T>(
    future: impl Future<Output = T>,
    port: &EffectAdmission,
    cancel: &CancellationToken,
    deadline: tokio::time::Instant,
) -> Result<T, &'static str> {
    tokio::pin!(future);
    let mut check = tokio::time::interval(Duration::from_millis(100));
    loop {
        tokio::select! {biased;
         _=cancel.cancelled()=>return Err("CANCELLED"),
         _=tokio::time::sleep_until(deadline)=>return Err("timeout"),
         _=check.tick()=>port.check().await.map_err(|e|e.0)?,
         value=&mut future=>return Ok(value),
        }
    }
}
pub(super) async fn fetch(
    args: &Value,
    port: &EffectAdmission,
    cancel: &CancellationToken,
) -> Result<Fetched, Failure> {
    let mut failure = Failure::new("web_fetch_failed");
    let result = async {
        port.check().await.map_err(|e| e.0)?;
        let mut current = normalize(args["url"].as_str().unwrap(), None)?;
        let requested = current.to_string();
        let started_at = crate::capability::now();
        let timeout = args["timeoutMs"]
            .as_f64()
            .unwrap_or(30000.0)
            .floor()
            .clamp(1.0, 120000.0) as u64;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout);
        let network = Network::new().map_err(|e| e.0)?;
        let mut secrets = Zeroizing::new(Vec::new());
        for step in 0..=5 {
            failure.status = None;
            failure.final_url = None;
            let prepared = wait(network.prepare(&current, cancel), port, cancel, deadline)
                .await?
                .map_err(|e| e.0)?;
            secrets.extend(prepared.secrets.iter().cloned());
            let (safe_url, redacted) = text::protect(current.as_str(), &secrets, 16384)?;
            failure.redacted |= redacted;
            failure.final_url = Some(safe_url);
            let client = prepared
                .builder
                .gzip(true)
                .brotli(true)
                .deflate(true)
                .connect_timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| "web_fetch_failed")?;
            port.check().await.map_err(|e| e.0)?;
            failure.dispatched = true;
            let mut response = wait(
                client
                    .get(current.clone())
                    .header("user-agent", "Peer-Agent/1.0 (+local.web.fetch)")
                    .header(
                        "accept",
                        "text/html,text/plain,application/json,application/xml;q=0.9,*/*;q=0.5",
                    )
                    .header("connection", "close")
                    .send(),
                port,
                cancel,
                deadline,
            )
            .await?
            .map_err(|e| {
                if e.is_timeout() {
                    "timeout"
                } else {
                    "web_fetch_failed"
                }
            })?;
            let status = response.status().as_u16();
            failure.status = Some(status);
            if (300..400).contains(&status) {
                let location = response
                    .headers()
                    .get("location")
                    .ok_or("redirect_without_location")?
                    .to_str()
                    .map_err(|_| "invalid_url")?;
                if step == 5 {
                    return Err("too_many_redirects");
                };
                current = normalize(location, Some(&current))?;
                continue;
            }
            if !(200..300).contains(&status) {
                return Err("web_http_error");
            }
            let mime = response
                .headers()
                .get("content-type")
                .map(|s| s.to_str().map(str::to_owned))
                .transpose()
                .map_err(|_| "web_content_invalid")?
                .unwrap_or_else(|| "text/plain".into());
            if mime.len() > 8192 {
                return Err("web_content_limit");
            }
            let mut bytes = Vec::new();
            while let Some(part) = wait(response.chunk(), port, cancel, deadline)
                .await?
                .map_err(|_| "web_fetch_failed")?
            {
                if bytes.len().saturating_add(part.len()) > 5_000_000 {
                    return Err("response_too_large");
                };
                bytes.extend_from_slice(&part);
            }
            port.check().await.map_err(|e| e.0)?;
            // Response/decompressor/client drop here before text expansion/regex work.
            return Ok(Fetched {
                requested,
                final_url: current.to_string(),
                mime,
                status,
                started_at,
                bytes,
                secrets,
            });
        }
        Err("too_many_redirects")
    }
    .await;
    result.map_err(|code| {
        failure.code = code;
        failure
    })
}
