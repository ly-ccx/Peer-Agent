//! Bounded OAuth HTTP port for the SDK. Never retries a token/code exchange.
use crate::{
    CancellationToken,
    network::{Network, pinned::ResponseBody},
};
use reqwest::Url;
use rmcp::transport::auth::{
    OAuthHttpClient, OAuthHttpClientFuture, OAuthHttpRedirectPolicy, OAuthHttpRequest,
};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};

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
impl Addresses {
    async fn approved(&self, url: &Url) -> Result<Vec<SocketAddr>, &'static str> {
        if !self.url(url) {
            return Err("mcp_oauth_address_denied");
        }
        let host = url
            .host_str()
            .ok_or("mcp_oauth_address_denied")?
            .trim_matches(['[', ']']);
        let port = url
            .port_or_known_default()
            .ok_or("mcp_oauth_address_denied")?;
        if let Ok(ip) = host.parse::<IpAddr>() {
            return Ok(vec![SocketAddr::new(ip, port)]);
        }
        let answers: Vec<_> = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "mcp_oauth_dns_failed")?
            .take(65)
            .collect();
        self.filter(answers)
    }
    fn filter(&self, answers: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, &'static str> {
        if answers.len() > 64 {
            return Err("mcp_oauth_dns_limit");
        }
        let mut approved: Vec<_> = answers
            .into_iter()
            .filter(|a| self.allows(a.ip()))
            .collect();
        if approved.is_empty() {
            return Err("mcp_oauth_address_denied");
        }
        // Stable IPv4 preference also lets explicit localhost bases retain
        // their existing IPv4 callback/test-server behavior through a proxy.
        approved.sort_by_key(|a| a.is_ipv6());
        let mut seen = std::collections::BTreeSet::new();
        approved.retain(|a| seen.insert(*a));
        Ok(approved)
    }
}
pub(super) struct BoundedHttp {
    network: Network,
    cancel: CancellationToken,
    addresses: Addresses,
    admission: Option<crate::effect_admission::EffectAdmission>,
}
impl BoundedHttp {
    pub fn with_admission(
        mut self,
        admission: Option<crate::effect_admission::EffectAdmission>,
    ) -> Self {
        self.admission = admission;
        self
    }
    async fn check_admission(&self) -> Result<(), &'static str> {
        if let Some(port) = &self.admission {
            port.check().await.map_err(|e| e.0)?;
        }
        Ok(())
    }
    pub async fn challenge(&self, base: &Url) -> Result<Option<String>, &'static str> {
        if !self.addresses.url(base) {
            return Err("mcp_oauth_address_denied");
        }
        let approved = self.addresses.approved(base).await?;
        self.check_admission().await?;
        let request = http::Request::builder()
            .uri(base.as_str())
            .header("MCP-Protocol-Version", "2025-11-25")
            .body(vec![])
            .map_err(|_| "mcp_oauth_request_invalid")?;
        let response = self
            .network
            .pinned_http(request, &approved, ResponseBody::HeadersOnly, &self.cancel)
            .await
            .map_err(|e| e.0)?;
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
    pub fn new(base: &Url, cancel: &CancellationToken) -> Result<Self, &'static str> {
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
        let network = Network::new().map_err(|e| e.0)?;
        Ok(Self {
            network,
            cancel: cancel.clone(),
            addresses,
            admission: None,
        })
    }
}
impl OAuthHttpClient for BoundedHttp {
    fn execute(&self, operation: OAuthHttpRequest) -> OAuthHttpClientFuture<'_> {
        Box::pin(async move {
            let execute = async {
                let mut url = Url::parse(&operation.request.uri().to_string())
                    .map_err(|_| "mcp_oauth_url_invalid")?;
                let origin = url.origin();
                if operation.request.body().len() > 262144 {
                    return Err("mcp_oauth_request_limit");
                }
                for hop in 0..=3 {
                    if url.origin() != origin {
                        return Err("mcp_oauth_address_denied");
                    }
                    let approved = self.addresses.approved(&url).await?;
                    self.check_admission().await?;
                    let mut request = http::Request::builder()
                        .method(operation.request.method().clone())
                        .uri(url.as_str())
                        .body(operation.request.body().clone())
                        .map_err(|_| "mcp_oauth_request_invalid")?;
                    *request.headers_mut() = operation.request.headers().clone();
                    let response = self
                        .network
                        .pinned_http(request, &approved, ResponseBody::Bounded, &self.cancel)
                        .await
                        .map_err(|e| e.0)?;
                    if response.status().is_redirection()
                        && matches!(operation.redirect_policy, OAuthHttpRedirectPolicy::Follow)
                    {
                        if hop == 3 {
                            return Err("mcp_oauth_redirect_limit");
                        }
                        let location = response
                            .headers()
                            .get("location")
                            .ok_or("mcp_oauth_redirect_invalid")?
                            .to_str()
                            .map_err(|_| "mcp_oauth_redirect_invalid")?;
                        url = url
                            .join(location)
                            .map_err(|_| "mcp_oauth_redirect_invalid")?;
                        continue;
                    }
                    return Ok(response);
                }
                Err("mcp_oauth_redirect_limit")
            };
            let result = tokio::select! {biased;
                _=self.cancel.cancelled()=>Err("CANCELLED"),
                value=tokio::time::timeout(Duration::from_secs(30),execute)=>value.map_err(|_|"mcp_oauth_timeout").and_then(|v|v),
            };
            result.map_err(|code| std::io::Error::other(code).into())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn dns_and_literal_policy_cannot_admit_metadata_loopback_or_private_via_proxy() {
        let public = Addresses {
            loopback: false,
            private: false,
        };
        for url in [
            "https://169.254.169.254/",
            "https://127.0.0.1/",
            "https://[::ffff:127.0.0.1]/",
            "https://10.0.0.1/",
            "https://[fd00::1]/",
            "http://localhost/",
        ] {
            assert!(
                public.approved(&Url::parse(url).unwrap()).await.is_err(),
                "{url}"
            );
        }
        assert!(
            public
                .approved(&Url::parse("https://localhost/").unwrap())
                .await
                .is_err()
        );
        let answers = vec![
            "127.0.0.1:443".parse().unwrap(),
            "8.8.8.8:443".parse().unwrap(),
            "10.0.0.1:443".parse().unwrap(),
            "8.8.8.8:443".parse().unwrap(),
            "169.254.169.254:443".parse().unwrap(),
        ];
        assert_eq!(
            public.filter(answers).unwrap(),
            vec!["8.8.8.8:443".parse::<SocketAddr>().unwrap()]
        );
        assert_eq!(
            public.filter(vec!["8.8.8.8:443".parse().unwrap(); 65]),
            Err("mcp_oauth_dns_limit")
        );
        let local = Addresses {
            loopback: true,
            private: false,
        };
        assert!(
            !local
                .approved(&Url::parse("http://localhost:1234/").unwrap())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            local
                .approved(&Url::parse("https://169.254.169.254/").unwrap())
                .await
                .is_err()
        );
        let private = Addresses {
            loopback: false,
            private: true,
        };
        assert!(private.url(&Url::parse("https://10.0.0.1/").unwrap()));
        assert!(!private.url(&Url::parse("http://10.0.0.1/").unwrap()));
    }
}
