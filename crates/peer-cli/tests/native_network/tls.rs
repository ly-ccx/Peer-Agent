//! Isolated TLS front for the suite's real HTTP/SSE server. No OS trust changes.
use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
pub(crate) const CA: &str = include_str!("../fixtures/network/ca.pem");
pub(crate) struct TlsFront {
    pub url: String,
    pub address: std::net::SocketAddr,
    stop: Arc<std::sync::atomic::AtomicBool>,
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
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let tunnel_stop = ended.clone();
        let worker = listeners(listener, ended, move |socket| {
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut tls = rustls::StreamOwned::new(
                rustls::ServerConnection::new(config.clone()).unwrap(),
                socket,
            );
            // TLS rejection/cancellation is an expected fixture input.
            if let Ok(body) = request(&mut tls) {
                let mut backend = TcpStream::connect(upstream).unwrap();
                backend
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                backend
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                if backend.write_all(&body).is_ok() {
                    if body.starts_with(b"CONNECT ") {
                        bridge(&mut tls, &mut backend, &tunnel_stop);
                        tls.conn.send_close_notify();
                        let _ = tls.flush();
                        return;
                    }
                    let mut bytes = [0; 8192];
                    while let Ok(count) = backend.read(&mut bytes) {
                        if count == 0
                            || tls
                                .write_all(&bytes[..count])
                                .and_then(|_| tls.flush())
                                .is_err()
                        {
                            break;
                        }
                    }
                }
                tls.conn.send_close_notify();
                let _ = tls.flush();
            }
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
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
pub(crate) struct ConnectProxy {
    pub url: String,
    pub headers: Arc<Mutex<Vec<String>>>,
    pub closed: Arc<std::sync::atomic::AtomicUsize>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
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
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let worker = listeners(listener, ended, move |mut client| {
            client
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let Ok(bytes) = request(&mut client) else {
                return;
            };
            let header = String::from_utf8(bytes).unwrap();
            assert!(header.starts_with("CONNECT "));
            captured.lock().unwrap().push(header);
            let mut upstream = TcpStream::connect(target).unwrap();
            upstream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            upstream
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .unwrap();
            let mut read_client = client.try_clone().unwrap();
            let mut write_upstream = upstream.try_clone().unwrap();
            let observed_close = observed_close.clone();
            let copy = thread::spawn(move || {
                if std::io::copy(&mut read_client, &mut write_upstream).is_ok() {
                    observed_close.fetch_add(1, std::sync::atomic::Ordering::Release);
                }
                let _ = write_upstream.shutdown(std::net::Shutdown::Write);
            });
            let _ = std::io::copy(&mut upstream, &mut client);
            let _ = client.shutdown(std::net::Shutdown::Both);
            copy.join().unwrap();
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
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}

// Legacy SSE and Streamable HTTP control POSTs require simultaneous sockets.
// Every fixture worker is bounded and joined; no detached test servers.
fn listeners(
    listener: TcpListener,
    stop: Arc<std::sync::atomic::AtomicBool>,
    serve: impl Fn(TcpStream) + Send + Sync + 'static,
) -> thread::JoinHandle<()> {
    let serve = Arc::new(serve);
    thread::spawn(move || {
        let mut workers: Vec<thread::JoinHandle<()>> = vec![];
        while !stop.load(std::sync::atomic::Ordering::Acquire) {
            let mut i = 0;
            while i < workers.len() {
                if workers[i].is_finished() {
                    workers.swap_remove(i).join().unwrap();
                } else {
                    i += 1;
                }
            }
            match listener.accept() {
                Ok((socket, _)) => {
                    assert!(workers.len() < 16, "synthetic connection bound");
                    socket.set_nonblocking(false).unwrap();
                    let serve = serve.clone();
                    workers.push(thread::spawn(move || serve(socket)));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5))
                }
                Err(_) => break,
            }
        }
        for worker in workers {
            worker.join().unwrap();
        }
    })
}

// TLS forward proxies need both directions after CONNECT, unlike a finite
// ordinary HTTP response. Poll both owned sockets; no detached copy thread.
fn bridge(
    tls: &mut rustls::StreamOwned<rustls::ServerConnection, TcpStream>,
    backend: &mut TcpStream,
    stop: &std::sync::atomic::AtomicBool,
) {
    tls.sock
        .set_read_timeout(Some(Duration::from_millis(10)))
        .unwrap();
    backend
        .set_read_timeout(Some(Duration::from_millis(10)))
        .unwrap();
    let mut bytes = [0; 8192];
    let mut deadline = Instant::now() + Duration::from_secs(3);
    while !stop.load(std::sync::atomic::Ordering::Acquire) && Instant::now() < deadline {
        match tls.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                if backend.write_all(&bytes[..n]).is_err() {
                    break;
                }
                deadline = Instant::now() + Duration::from_secs(3);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }
        match backend.read(&mut bytes) {
            Ok(0) => break,
            Ok(n) => {
                if tls
                    .write_all(&bytes[..n])
                    .and_then(|_| tls.flush())
                    .is_err()
                {
                    break;
                }
                deadline = Instant::now() + Duration::from_secs(3);
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => break,
        }
    }
    let _ = backend.shutdown(std::net::Shutdown::Both);
}
