//! One approved numeric destination per OAuth HTTP operation. The SDK owns
//! OAuth; this port owns sockets, proxy tunnelling, TLS and bounded HTTP/1 IO.
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use std::{
    net::SocketAddr,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub(crate) enum ResponseBody {
    HeadersOnly,
    Bounded,
}
trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
type OwnedIo = Box<dyn Io>;
// hyper's buffer setting checks an incomplete parse; a complete oversized head
// received in one read can pass it. Bound actual reads until hyper publishes
// the final response. This also bounds all informational heads together, while
// leaving HTTP parsing and upgrades entirely to hyper.
struct HeaderIo {
    inner: OwnedIo,
    remaining: usize,
    body: Arc<AtomicBool>,
}
fn header_io(inner: OwnedIo) -> (HeaderIo, Arc<AtomicBool>) {
    let body = Arc::new(AtomicBool::new(false));
    (
        HeaderIo {
            inner,
            remaining: 32768,
            body: body.clone(),
        },
        body,
    )
}
impl AsyncRead for HeaderIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.body.load(Ordering::Acquire) {
            return Pin::new(&mut self.inner).poll_read(cx, buf);
        }
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.remaining == 0 {
            return Poll::Ready(Err(std::io::Error::other("mcp_oauth_header_limit")));
        }
        let limit = self.remaining.min(buf.remaining());
        let mut read = ReadBuf::new(buf.initialize_unfilled_to(limit));
        let result = Pin::new(&mut self.inner).poll_read(cx, &mut read);
        let count = read.filled().len();
        self.remaining -= count;
        buf.advance(count);
        result
    }
}
impl AsyncWrite for HeaderIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
fn failed(code: &'static str) -> Error {
    Error(code)
}
impl Network {
    pub(crate) async fn pinned_http(
        &self,
        request: http::Request<Vec<u8>>,
        approved: &[SocketAddr],
        body: ResponseBody,
        cancel: &CancellationToken,
    ) -> Result<http::Response<Vec<u8>>, Error> {
        if request.body().len() > 262144
            || request.headers().len() > 100
            || request.uri().to_string().len()
                + request
                    .headers()
                    .iter()
                    .map(|(k, v)| k.as_str().len() + v.as_bytes().len() + 4)
                    .sum::<usize>()
                > 32768
        {
            return Err(failed("mcp_oauth_request_limit"));
        }
        let url =
            Url::parse(&request.uri().to_string()).map_err(|_| failed("mcp_oauth_url_invalid"))?;
        let port = url
            .port_or_known_default()
            .ok_or(failed("mcp_oauth_url_invalid"))?;
        if !matches!(url.scheme(), "http" | "https")
            || approved.is_empty()
            || approved.len() > 64
            || approved.iter().any(|a| a.port() != port)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(failed("mcp_oauth_address_denied"));
        }
        let operation = async {
            let proxy = self.route(&url, cancel).await?;
            let roots = if url.scheme() == "https"
                || proxy.as_ref().is_some_and(|p| p.scheme() == "https")
            {
                system::roots(cancel).await?
            } else {
                &[]
            };
            let io: OwnedIo = if let Some(proxy) = proxy {
                self.tunnel(proxy, approved[0], roots).await?
            } else {
                let socket = tokio::time::timeout(
                    Duration::from_secs(5),
                    tokio::net::TcpStream::connect(approved),
                )
                .await
                .map_err(|_| failed("mcp_oauth_connect_timeout"))?
                .map_err(|_| failed("mcp_oauth_connect_failed"))?;
                Box::new(socket)
            };
            let io: OwnedIo = if url.scheme() == "https" {
                let host = url
                    .host_str()
                    .ok_or(failed("mcp_oauth_url_invalid"))?
                    .trim_matches(['[', ']']);
                self.tls(io, host, roots).await?
            } else {
                io
            };
            exchange(io, request, &url, body).await
        };
        tokio::select! {biased;
            _=cancel.cancelled()=>Err(failed("CANCELLED")),
            value=tokio::time::timeout(Duration::from_secs(30),operation)=>value.map_err(|_|failed("mcp_oauth_timeout"))?,
        }
    }
    async fn tls(&self, io: OwnedIo, host: &str, roots: &[Root]) -> Result<OwnedIo, Error> {
        let mut store = rustls::RootCertStore::empty();
        store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        for root in self.extra.iter().chain(roots.iter()) {
            store
                .add(root.der.clone())
                .map_err(|_| failed("network_ca_invalid"))?;
        }
        let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| failed("mcp_oauth_tls_unavailable"))?
        .with_root_certificates(store)
        .with_no_client_auth();
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let name = rustls::pki_types::ServerName::try_from(host.to_owned())
            .map_err(|_| failed("mcp_oauth_url_invalid"))?;
        let tls = tokio::time::timeout(
            Duration::from_secs(5),
            tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, io),
        )
        .await
        .map_err(|_| failed("mcp_oauth_tls_timeout"))?
        .map_err(|_| failed("mcp_oauth_tls_failed"))?;
        Ok(Box::new(tls))
    }
    async fn tunnel(
        &self,
        proxy: Url,
        target: SocketAddr,
        roots: &[Root],
    ) -> Result<OwnedIo, Error> {
        let host = proxy
            .host_str()
            .ok_or(failed("network_proxy_invalid"))?
            .trim_matches(['[', ']']);
        let port = proxy
            .port_or_known_default()
            .ok_or(failed("network_proxy_invalid"))?;
        let socket = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect((host, port)),
        )
        .await
        .map_err(|_| failed("mcp_oauth_proxy_timeout"))?
        .map_err(|_| failed("mcp_oauth_proxy_failed"))?;
        let io: OwnedIo = Box::new(socket);
        let io = if proxy.scheme() == "https" {
            self.tls(io, host, roots).await?
        } else {
            io
        };
        let (io, body) = header_io(io);
        let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
            .max_buf_size(32768)
            .max_headers(100)
            .handshake(TokioIo::new(io))
            .await
            .map_err(|_| failed("mcp_oauth_proxy_failed"))?;
        let mut request = http::Request::builder()
            .method(http::Method::CONNECT)
            .uri(target.to_string())
            .header(http::header::HOST, target.to_string());
        if let Some(auth) = proxy_auth(&proxy) {
            let mut value =
                http::HeaderValue::from_str(&auth).map_err(|_| failed("network_proxy_invalid"))?;
            value.set_sensitive(true);
            request = request.header(http::header::PROXY_AUTHORIZATION, value);
        }
        let request = request
            .body(Full::new(Bytes::new()))
            .map_err(|_| failed("mcp_oauth_request_invalid"))?;
        let exchange = async move {
            let response = sender
                .send_request(request)
                .await
                .map_err(|_| failed("mcp_oauth_proxy_failed"))?;
            body.store(true, Ordering::Release);
            if !response.status().is_success() {
                return Err(failed("mcp_oauth_proxy_rejected"));
            }
            let upgraded = hyper::upgrade::on(response)
                .await
                .map_err(|_| failed("mcp_oauth_proxy_failed"))?;
            Ok(Box::new(TokioIo::new(upgraded)) as OwnedIo)
        };
        tokio::time::timeout(
            Duration::from_secs(5),
            drive(connection.with_upgrades(), exchange),
        )
        .await
        .map_err(|_| failed("mcp_oauth_proxy_timeout"))?
    }
}
async fn exchange(
    io: OwnedIo,
    request: http::Request<Vec<u8>>,
    url: &Url,
    body: ResponseBody,
) -> Result<http::Response<Vec<u8>>, Error> {
    let (io, body_ready) = header_io(io);
    let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
        .max_buf_size(32768)
        .max_headers(100)
        .handshake(TokioIo::new(io))
        .await
        .map_err(|_| failed("mcp_oauth_http_failed"))?;
    let (mut parts, bytes) = request.into_parts();
    let path = format!(
        "{}{}",
        url.path(),
        url.query().map(|q| format!("?{q}")).unwrap_or_default()
    );
    parts.uri = path.parse().map_err(|_| failed("mcp_oauth_url_invalid"))?;
    parts.version = http::Version::HTTP_11;
    parts.headers.remove(http::header::PROXY_AUTHORIZATION);
    parts.headers.insert(
        http::header::HOST,
        format!(
            "{}{}",
            url.host_str().ok_or(failed("mcp_oauth_url_invalid"))?,
            url.port().map(|p| format!(":{p}")).unwrap_or_default()
        )
        .parse()
        .map_err(|_| failed("mcp_oauth_url_invalid"))?,
    );
    parts.headers.insert(
        http::header::CONNECTION,
        http::HeaderValue::from_static("close"),
    );
    let request = http::Request::from_parts(parts, Full::new(Bytes::from(bytes)));
    let exchange = async move {
        let response = sender
            .send_request(request)
            .await
            .map_err(|_| failed("mcp_oauth_http_failed"))?;
        body_ready.store(true, Ordering::Release);
        let (parts, mut incoming) = response.into_parts();
        let mut bytes = Vec::new();
        if matches!(body, ResponseBody::Bounded) {
            while let Some(frame) = incoming.frame().await {
                let frame = frame.map_err(|_| failed("mcp_oauth_http_failed"))?;
                if let Some(data) = frame.data_ref() {
                    if bytes.len() + data.len() > 1024 * 1024 {
                        return Err(failed("mcp_oauth_response_limit"));
                    }
                    bytes.extend_from_slice(data);
                }
            }
        }
        Ok(http::Response::from_parts(parts, bytes))
    };
    drive(connection, exchange).await
}
async fn drive<T>(
    connection: impl std::future::Future<Output = Result<(), hyper::Error>>,
    exchange: impl std::future::Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    tokio::pin!(connection, exchange);
    // Finishing headers-only responses, failed bodies and cancellation all drop
    // the driver and socket together. No detached connection task is spawned.
    tokio::select! {biased;
        result=&mut exchange=>result,
        result=&mut connection=>{result.map_err(|_|failed("mcp_oauth_http_failed"))?;exchange.await},
    }
}

#[cfg(test)]
mod tests;
