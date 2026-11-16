//! Original CLI network policy. Routing and trust are configuration, never a
//! tool grant. Each physical request selects its route without an implicit retry.
use crate::CancellationToken;
use reqwest::{Certificate, ClientBuilder, Url};
use std::collections::BTreeMap;
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
    pub(crate) async fn builder(
        &self,
        url: &Url,
        cancel: &CancellationToken,
    ) -> Result<ClientBuilder, Error> {
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
        Ok(builder)
    }
}
