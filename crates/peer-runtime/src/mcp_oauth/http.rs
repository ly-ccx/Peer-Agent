//! Bounded OAuth HTTP port for the SDK. Never retries a token/code exchange.
use reqwest::{
    Client, Url,
    dns::{Addrs, Name, Resolve, Resolving},
};
use rmcp::transport::auth::{
    OAuthHttpClient, OAuthHttpClientFuture, OAuthHttpRedirectPolicy, OAuthHttpRequest,
};
use std::{net::IpAddr, sync::Arc, time::Duration};

#[derive(Clone)]
struct Addresses {
    loopback: bool,
    private: bool,
}
impl Addresses {
    fn allows(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V6(v) if v.to_ipv4_mapped().is_some() => {
                self.allows(IpAddr::V4(v.to_ipv4_mapped().unwrap()))
            }
            IpAddr::V4(v) => {
                let [a, b, c, _] = v.octets();
                if v.is_loopback() {
                    return self.loopback;
                }
                if v.is_private() || (a == 100 && (64..=127).contains(&b)) {
                    return self.private;
                }
                !(v.is_unspecified()
                    || v.is_broadcast()
                    || v.is_multicast()
                    || v.is_link_local()
                    || a == 0
                    || a >= 224
                    || (a == 192 && (b == 0 || (b == 88 && c == 99)))
                    || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                    || (a == 203 && b == 0 && c == 113))
            }
            IpAddr::V6(v) => {
                if v.is_loopback() {
                    return self.loopback;
                }
                if (v.segments()[0] & 0xfe00) == 0xfc00 {
                    return self.private;
                }
                (v.segments()[0] & 0xe000) == 0x2000
                    && v.segments()[0] != 0x2002
                    && !(v.segments()[0] == 0x2001 && matches!(v.segments()[1], 0 | 2 | 0xdb8))
            }
        }
    }
    fn url(&self, url: &Url) -> bool {
        let raw = url.host_str().unwrap_or("").trim_matches(['[', ']']);
        let ip = raw.parse::<IpAddr>().ok();
        !raw.is_empty()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && (url.scheme() == "https"
                || (url.scheme() == "http"
                    && self.loopback
                    && (ip.is_some_and(|v| v.is_loopback())
                        || raw.eq_ignore_ascii_case("localhost"))))
            && ip.is_none_or(|v| self.allows(v))
    }
}
impl Resolve for Addresses {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.clone();
        let host = name.as_str().to_owned();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host, 0))
                .await?
                .filter(|v| policy.allows(v.ip()))
                .collect::<Vec<_>>();
            if addresses.is_empty() {
                return Err(std::io::Error::other("mcp_oauth_address_denied").into());
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}
pub(super) struct BoundedHttp {
    client: Client,
    addresses: Addresses,
}
impl BoundedHttp {
    pub async fn challenge(&self, base: &Url) -> Result<Option<String>, &'static str> {
        if !self.addresses.url(base) {
            return Err("mcp_oauth_address_denied");
        }
        let response = self
            .client
            .get(base.clone())
            .header("MCP-Protocol-Version", "2025-11-25")
            .send()
            .await
            .map_err(|_| "mcp_oauth_discovery_failed")?;
        if response.status() != reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        response
            .headers()
            .get("www-authenticate")
            .map(|v| {
                v.to_str()
                    .ok()
                    .filter(|v| v.len() <= 8192)
                    .map(str::to_owned)
                    .ok_or("mcp_oauth_challenge_invalid")
            })
            .transpose()
    }
    pub fn new(base: &Url) -> Result<Self, &'static str> {
        let ip = base
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .ok();
        let addresses = Addresses {
            loopback: ip.is_some_and(|v| v.is_loopback()) || base.host_str() == Some("localhost"),
            private: ip.is_some_and(|v| match v {
                IpAddr::V4(v) => v.is_private(),
                IpAddr::V6(v) => (v.segments()[0] & 0xfe00) == 0xfc00,
            }),
        };
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .dns_resolver(Arc::new(addresses.clone()))
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "mcp_oauth_http_unavailable")?;
        Ok(Self { client, addresses })
    }
}
impl OAuthHttpClient for BoundedHttp {
    fn execute(&self, operation: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(async move {
            let mut url = Url::parse(&operation.request.uri().to_string())?;
            let origin = url.origin();
            if operation.request.body().len() > 262144 {
                return Err(std::io::Error::other("mcp_oauth_request_limit").into());
            }
            for hop in 0..=3 {
                if !self.addresses.url(&url) || url.origin() != origin {
                    return Err(std::io::Error::other("mcp_oauth_address_denied").into());
                }
                let mut response = self
                    .client
                    .request(operation.request.method().clone(), url.clone())
                    .headers(operation.request.headers().clone())
                    .body(operation.request.body().clone())
                    .send()
                    .await?;
                if response.status().is_redirection()
                    && matches!(operation.redirect_policy, OAuthHttpRedirectPolicy::Follow)
                {
                    if hop == 3 {
                        return Err(std::io::Error::other("mcp_oauth_redirect_limit").into());
                    }
                    let location = response
                        .headers()
                        .get("location")
                        .ok_or_else(|| std::io::Error::other("mcp_oauth_redirect_invalid"))?
                        .to_str()?;
                    url = url.join(location)?;
                    continue;
                }
                let mut builder = http::Response::builder().status(response.status());
                *builder
                    .headers_mut()
                    .ok_or_else(|| std::io::Error::other("mcp_oauth_response_invalid"))? =
                    response.headers().clone();
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    if bytes.len() + chunk.len() > 1024 * 1024 {
                        return Err(std::io::Error::other("mcp_oauth_response_limit").into());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                return Ok(builder.body(bytes)?);
            }
            Err(std::io::Error::other("mcp_oauth_redirect_limit").into())
        })
    }
}
