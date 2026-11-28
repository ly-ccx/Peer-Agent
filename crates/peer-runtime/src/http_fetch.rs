//! Bounded HTTP GET helper for native CLI maintenance operations (e.g. `peer update`).
//! Uses rustls TLS and enforces explicit timeout, redirect, and byte-size budgets.
use std::time::Duration;

pub async fn get_bytes(
    url: &str,
    accept: Option<&str>,
    user_agent: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(user_agent);

    if let Ok(path) =
        std::env::var("SSL_CERT_FILE").or_else(|_| std::env::var("NODE_EXTRA_CA_CERTS"))
        && let Ok(pem) = std::fs::read(&path)
        && let Ok(certs) = reqwest::Certificate::from_pem_bundle(&pem)
    {
        for cert in certs {
            builder = builder.add_root_certificate(cert);
        }
    }

    let client = builder
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let mut req = client.get(url);
    if let Some(accept) = accept {
        req = req.header(reqwest::header::ACCEPT, accept);
    }
    let mut resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    if let Some(len) = resp.content_length()
        && len > max_bytes as u64
    {
        return Err(format!("response exceeds {max_bytes} byte limit"));
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if out.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("response exceeds {max_bytes} byte limit"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}
