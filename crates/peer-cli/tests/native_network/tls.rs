//! Isolated TLS front for the suite's real HTTP/SSE server. No OS trust changes.
use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
pub(crate) const CA: &str = include_str!("../fixtures/network/ca.pem");
pub(crate) struct TlsFront {
    pub url: String,
    pub address: std::net::SocketAddr,
    stop: peer_runtime::CancellationToken,
    worker: Option<thread::JoinHandle<()>>,
}
pub(crate) fn request(stream: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut bytes = vec![];
    let mut one = [0u8; 1];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() > 32768 {
            return Err(std::io::Error::other("fixture header limit"));
        }
        stream.read_exact(&mut one)?;
        bytes.push(one[0]);
    }
    let header = String::from_utf8_lossy(&bytes);
    let length = header
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|s| s.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 2 * 1024 * 1024 {
        return Err(std::io::Error::other("fixture body limit"));
    }
    let start = bytes.len();
    bytes.resize(start + length, 0);
    stream.read_exact(&mut bytes[start..])?;
    Ok(bytes)
}

#[test]
fn tls_proxy_keeps_a_tunnel_open_within_the_real_five_second_connect_budget() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stopped = stop.clone();
    let backend = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !stopped.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(6)))
                        .unwrap();
                    socket
                        .set_write_timeout(Some(Duration::from_secs(6)))
                        .unwrap();
                    if request(&mut socket).is_ok() {
                        let _ = socket.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
                        let mut bytes = [0; 4];
                        if socket.read_exact(&mut bytes).is_ok() {
                            let _ = socket.write_all(&bytes);
                        }
                    }
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => return,
            }
        }
    });
    let front = TlsFront::for_url(&format!("http://{address}"), false);
    let proxy = ConnectProxy::new(front.address);
    let result = (|| -> std::io::Result<()> {
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(CA.as_bytes()).unwrap())
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let connection = rustls::ClientConnection::new(
            Arc::new(config),
            rustls::pki_types::ServerName::try_from("localhost").unwrap(),
        )
        .unwrap();
        let socket = TcpStream::connect(
            url::Url::parse(&proxy.url)
                .unwrap()
                .socket_addrs(|| None)
                .unwrap()[0],
        )?;
        socket.set_read_timeout(Some(Duration::from_secs(6)))?;
        socket.set_write_timeout(Some(Duration::from_secs(6)))?;
        let mut socket = socket;
        write!(
            socket,
            "CONNECT {} HTTP/1.1\r\nHost: {}\r\n\r\n",
            front.address, front.address
        )?;
        assert!(request(&mut socket)?.starts_with(b"HTTP/1.1 200"));
        let mut tls = rustls::StreamOwned::new(connection, socket);
        write!(tls, "CONNECT {address} HTTP/1.1\r\nHost: {address}\r\n\r\n")?;
        tls.flush()?;
        let header = request(&mut tls)?;
        assert!(header.starts_with(b"HTTP/1.1 200"));
        // A legal connect/handshake pause, shorter than the product's 5s limit.
        thread::sleep(Duration::from_secs(4));
        tls.write_all(b"ping")?;
        tls.flush()?;
        let mut bytes = [0; 4];
        tls.read_exact(&mut bytes)?;
        assert_eq!(&bytes, b"ping");
        Ok(())
    })();
    drop(proxy);
    drop(front);
    stop.store(true, std::sync::atomic::Ordering::Release);
    backend.join().unwrap();
    assert!(
        result.is_ok(),
        "fixture truncated a valid tunnel: {result:?}"
    );
}
impl TlsFront {
    pub fn new(server: &Server, wrong_name: bool) -> Self {
        Self::for_url(&server.url, wrong_name)
    }
    pub fn for_url(url: &str, wrong_name: bool) -> Self {
        let (certificate, key) = if wrong_name {
            (
                include_bytes!("../fixtures/network/wrong.pem").as_slice(),
                include_bytes!("../fixtures/network/wrong.key").as_slice(),
            )
        } else {
            (
                include_bytes!("../fixtures/network/server.pem").as_slice(),
                include_bytes!("../fixtures/network/server.key").as_slice(),
            )
        };
        Self::with_certificate(url, certificate, key)
    }
    pub(crate) fn with_certificate(url: &str, certificate: &[u8], key: &[u8]) -> Self {
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from_pem_slice(certificate).unwrap()],
            PrivateKeyDer::from_pem_slice(key).unwrap(),
        )
        .unwrap();
        let config = Arc::new(config);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let upstream = url::Url::parse(url).unwrap().socket_addrs(|| None).unwrap()[0];
        let stop = peer_runtime::CancellationToken::new();
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener=tokio::net::TcpListener::from_std(listener).unwrap();
                let mut clients=tokio::task::JoinSet::new();
                loop {
                    tokio::select! {biased;
                        _=ended.cancelled()=>break,
                        result=clients.join_next(),if !clients.is_empty()=>{assert!(result.unwrap().is_ok());},
                        accepted=listener.accept()=>{
                            let Ok((socket,_))=accepted else {break};
                            assert!(clients.len()<16,"synthetic connection bound");
                            let config=config.clone();let cancel=ended.child_token();
                            clients.spawn(async move {
                                let serve=async move {
                                    use tokio::io::AsyncWriteExt;
                                    let mut tls=tokio_rustls::TlsAcceptor::from(config).accept(socket).await?;
                                    let body=async_request(&mut tls).await?;
                                    let mut backend=tokio::net::TcpStream::connect(upstream).await?;
                                    backend.write_all(&body).await?;
                                    // Both directions remain alive through CONNECT, streamed
                                    // responses and client EOF. Never poll TLS with short
                                    // blocking read timeouts or truncate after one EOF.
                                    tokio::io::copy_bidirectional(&mut tls,&mut backend).await?;
                                    tls.shutdown().await
                                };
                                tokio::select! {biased;
                                    _=cancel.cancelled()=>{},
                                    _=tokio::time::timeout(Duration::from_secs(30),serve)=>{},
                                }
                            });
                        }
                    }
                }
                while let Some(result)=clients.join_next().await {assert!(result.is_ok());}
            });
        });
        Self {
            url: format!("https://{address}/v1"),
            address,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for TlsFront {
    fn drop(&mut self) {
        self.stop.cancel();
        self.worker.take().unwrap().join().unwrap();
    }
}
pub(crate) struct ConnectProxy {
    pub url: String,
    pub headers: Arc<Mutex<Vec<String>>>,
    pub closed: Arc<std::sync::atomic::AtomicUsize>,
    stop: peer_runtime::CancellationToken,
    worker: Option<thread::JoinHandle<()>>,
}

#[test]
fn proxy_observes_an_abrupt_client_reset_as_closed_without_an_idle_timeout() {
    let backend = TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy = ConnectProxy::new(backend.local_addr().unwrap());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let address = url::Url::parse(&proxy.url)
            .unwrap()
            .socket_addrs(|| None)
            .unwrap()[0];
        let mut client = tokio::net::TcpStream::connect(address).await.unwrap();
        client
            .write_all(b"CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n")
            .await
            .unwrap();
        assert!(
            async_request(&mut client)
                .await
                .unwrap()
                .starts_with(b"HTTP/1.1 200")
        );
        let (upstream, _) = backend.accept().unwrap();
        drop(upstream);
        let eof = tokio::time::timeout(Duration::from_secs(1), client.read_u8())
            .await
            .unwrap();
        assert_eq!(eof.unwrap_err().kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(
            proxy.closed.load(std::sync::atomic::Ordering::Acquire),
            0,
            "upstream half-close is not client closure"
        );
        // SO_LINGER=0 forces TCP RST. This is a real closed peer, not an EOF
        // or the fixture's read/write idle timeout.
        client.set_linger(Some(Duration::ZERO)).unwrap();
        drop(client);
        let deadline = Instant::now() + Duration::from_secs(1);
        while proxy.closed.load(std::sync::atomic::Ordering::Acquire) != 1 {
            assert!(
                Instant::now() < deadline,
                "reset client was not observed as closed"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
}
impl ConnectProxy {
    pub fn new(target: std::net::SocketAddr) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let headers = Arc::new(Mutex::new(vec![]));
        let captured = headers.clone();
        let closed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let observed_close = closed.clone();
        let stop = peer_runtime::CancellationToken::new();
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let mut clients = tokio::task::JoinSet::new();
                loop {
                    tokio::select! {biased;
                        _=ended.cancelled()=>break,
                        result=clients.join_next(),if !clients.is_empty()=>{assert!(result.unwrap().is_ok());},
                        accepted=listener.accept()=>{
                            let Ok((socket,_))=accepted else {break};
                            assert!(clients.len()<16,"synthetic connection bound");
                            let captured=captured.clone();let closed=observed_close.clone();let cancel=ended.child_token();
                            clients.spawn(async move {
                                let serve=async move {
                                    use tokio::io::AsyncWriteExt;
                                    let mut client=ObservedClient{socket,closed,ended:false};
                                    let bytes=async_request(&mut client).await?;
                                    let header=String::from_utf8(bytes).map_err(std::io::Error::other)?;
                                    assert!(header.starts_with("CONNECT "));
                                    captured.lock().unwrap().push(header);
                                    let mut upstream=tokio::net::TcpStream::connect(target).await?;
                                    client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await?;
                                    // Propagate each half-close, keeping the opposite direction
                                    // owned until its actual EOF/reset, cancellation or deadline.
                                    tokio::io::copy_bidirectional(&mut client,&mut upstream).await
                                };
                                tokio::select! {biased;
                                    _=cancel.cancelled()=>{},
                                    _=tokio::time::timeout(Duration::from_secs(30),serve)=>{},
                                }
                            });
                        }
                    }
                }
                while let Some(result)=clients.join_next().await {assert!(result.is_ok());}
            });
        });
        Self {
            url: format!("http://synthetic-user:synthetic-proxy-secret@{address}"),
            headers,
            closed,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for ConnectProxy {
    fn drop(&mut self) {
        self.stop.cancel();
        self.worker.take().unwrap().join().unwrap();
    }
}

// A client read owns closure evidence. A write failure, fixture timeout or
// local socket teardown cannot manufacture an observed closed remote client.
struct ObservedClient {
    socket: tokio::net::TcpStream,
    closed: Arc<std::sync::atomic::AtomicUsize>,
    ended: bool,
}
impl tokio::io::AsyncRead for ObservedClient {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let capacity = buf.remaining();
        let result = std::pin::Pin::new(&mut self.socket).poll_read(cx, buf);
        let closed = matches!(&result,std::task::Poll::Ready(Ok(())) if capacity>0 && buf.filled().len()==before)
            || matches!(&result,std::task::Poll::Ready(Err(e)) if e.kind()==std::io::ErrorKind::ConnectionReset);
        if closed && !self.ended {
            self.ended = true;
            self.closed
                .fetch_add(1, std::sync::atomic::Ordering::Release);
        }
        result
    }
}
impl tokio::io::AsyncWrite for ObservedClient {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.socket).poll_write(cx, buf)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.socket).poll_flush(cx)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.socket).poll_shutdown(cx)
    }
}

// Same bounded request shape as the synchronous proxy fixtures, with owned
// asynchronous TLS IO. All live server work belongs to the parent's JoinSet.
async fn async_request(
    stream: &mut (impl tokio::io::AsyncRead + Unpin),
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() > 32768 {
            return Err(std::io::Error::other("fixture header limit"));
        }
        bytes.push(stream.read_u8().await?);
    }
    let header = String::from_utf8_lossy(&bytes);
    let length = header
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|s| s.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if length > 2 * 1024 * 1024 {
        return Err(std::io::Error::other("fixture body limit"));
    }
    let start = bytes.len();
    bytes.resize(start + length, 0);
    stream.read_exact(&mut bytes[start..]).await?;
    Ok(bytes)
}
