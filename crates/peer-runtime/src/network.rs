//! Native CLI network policy shared by model and ordinary MCP HTTP adapters.
//! Routing/trust never grant tools. A prepared client is bound to its one
//! physical destination: no redirect, retry, fallback or cross-origin reuse.
use crate::CancellationToken;
use reqwest::{Certificate, ClientBuilder, Url};
use std::collections::BTreeMap;
use zeroize::Zeroizing;
mod environment;
mod system;
mod trust;
use environment::Environment;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Error(pub &'static str);
pub(crate) struct Network {
    environment: Environment,
    extra: Vec<Certificate>,
}
/// Routing material is ephemeral. Callers that return untrusted server data
/// retain only the selected route's protection patterns until that data is safe.
pub(crate) struct Prepared {
    pub builder: ClientBuilder,
    pub secrets: Zeroizing<Vec<String>>,
}
impl Network {
    pub(crate) fn new() -> Result<Self, Error> {
        let environment = Environment::read()?;
        let extra = environment
            .extra_ca
            .as_deref()
            .map(trust::read_extra)
            .transpose()?
            .unwrap_or_default();
        Ok(Self { environment, extra })
    }
    pub(crate) async fn prepare(
        &self,
        url: &Url,
        cancel: &CancellationToken,
    ) -> Result<Prepared, Error> {
        if cancel.is_cancelled() {
            return Err(Error("CANCELLED"));
        }
        let system = if self.environment.needs_system(url) {
            system::proxy(cancel).await?
        } else {
            BTreeMap::new()
        };
        let route = self.environment.select(url, &system);
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .pool_max_idle_per_host(0);
        let mut tls = url.scheme() == "https";
        let mut secrets = Zeroizing::new(Vec::new());
        if let Some(raw) = route {
            let proxy = Url::parse(raw).map_err(|_| Error("network_proxy_invalid"))?;
            if !matches!(proxy.scheme(), "http" | "https")
                || proxy.host_str().is_none()
                || proxy.fragment().is_some()
                || proxy.query().is_some()
            {
                return Err(Error("network_proxy_invalid"));
            }
            tls |= proxy.scheme() == "https";
            secrets.extend(proxy_secrets(&proxy).iter().cloned());
            // reqwest 0.12 only inserts non-tunnel proxy auth for http://
            // proxies. An https:// proxy forwarding an HTTP destination needs
            // the same sensitive header on that physical proxy connection.
            // There is no direct fallback, redirect or client reuse here.
            if url.scheme() == "http"
                && proxy.scheme() == "https"
                && let Some(auth) = proxy_auth(&proxy)
            {
                let mut headers = reqwest::header::HeaderMap::new();
                let mut value = reqwest::header::HeaderValue::from_str(&auth)
                    .map_err(|_| Error("network_proxy_invalid"))?;
                value.set_sensitive(true);
                headers.insert(reqwest::header::PROXY_AUTHORIZATION, value);
                builder = builder.default_headers(headers);
            }
            builder = builder
                .proxy(reqwest::Proxy::all(proxy).map_err(|_| Error("network_proxy_invalid"))?);
        }
        let system_roots = if tls {
            system::roots(cancel).await?
        } else {
            &[]
        };
        for certificate in self.extra.iter().chain(system_roots.iter()) {
            builder = builder.add_root_certificate(certificate.clone());
        }
        if cancel.is_cancelled() {
            return Err(Error("CANCELLED"));
        }
        Ok(Prepared { builder, secrets })
    }
}

fn proxy_secrets(proxy: &Url) -> Zeroizing<Vec<String>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use percent_encoding::percent_decode_str;
    let mut secrets = Zeroizing::new(Vec::new());
    if proxy.username().is_empty() && proxy.password().is_none() {
        return secrets;
    }
    let username = percent_decode_str(proxy.username()).decode_utf8_lossy();
    let password = percent_decode_str(proxy.password().unwrap_or("")).decode_utf8_lossy();
    for value in [
        proxy.username(),
        proxy.password().unwrap_or(""),
        &username,
        &password,
    ] {
        if !value.is_empty() && !secrets.iter().any(|old| old == value) {
            secrets.push(value.to_owned());
        }
    }
    let pair = Zeroizing::new(format!("{username}:{password}"));
    secrets.push(proxy.as_str().to_owned());
    secrets.push(format!("Basic {}", STANDARD.encode(pair.as_bytes())));
    secrets.push(STANDARD.encode(pair.as_bytes()));
    secrets
}

fn proxy_auth(proxy: &Url) -> Option<Zeroizing<String>> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use percent_encoding::percent_decode_str;
    if proxy.username().is_empty() && proxy.password().is_none() {
        return None;
    }
    let username = percent_decode_str(proxy.username()).decode_utf8_lossy();
    let password = percent_decode_str(proxy.password().unwrap_or("")).decode_utf8_lossy();
    let pair = Zeroizing::new(format!("{username}:{password}"));
    Some(Zeroizing::new(format!(
        "Basic {}",
        STANDARD.encode(pair.as_bytes())
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_proxy_protection_covers_uri_decoded_and_basic_wire_values() {
        let proxy = Url::parse("https://synthetic%20user:secret%3Avalue@127.0.0.1:1234").unwrap();
        let values = proxy_secrets(&proxy);
        for expected in [
            "synthetic%20user",
            "synthetic user",
            "secret%3Avalue",
            "secret:value",
            "Basic c3ludGhldGljIHVzZXI6c2VjcmV0OnZhbHVl",
            "c3ludGhldGljIHVzZXI6c2VjcmV0OnZhbHVl",
        ] {
            assert!(values.iter().any(|v| v == expected));
        }
        assert_eq!(
            proxy_auth(&proxy).unwrap().as_str(),
            "Basic c3ludGhldGljIHVzZXI6c2VjcmV0OnZhbHVl"
        );
        let plain = Url::parse("http://127.0.0.1:1234").unwrap();
        assert!(proxy_secrets(&plain).is_empty());
        assert!(proxy_auth(&plain).is_none());
    }
}
