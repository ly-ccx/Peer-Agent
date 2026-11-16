//! Isolated TLS front for the suite's real HTTP/SSE server. No OS trust changes.
use super::*;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject};
pub(super) const CA: &str = include_str!("../fixtures/network/ca.pem");
pub(super) struct TlsFront {
    pub url: String,
    pub address: std::net::SocketAddr,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
pub(super) fn request(stream: &mut impl Read) -> std::io::Result<Vec<u8>> {
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
        let upstream = url::Url::parse(&server.url)
            .unwrap()
            .socket_addrs(|| None)
            .unwrap()[0];
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            while !ended.load(std::sync::atomic::Ordering::Acquire) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
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
                        match request(&mut tls) {
                            Ok(body) => {
                                let mut backend = TcpStream::connect(upstream).unwrap();
                                backend
                                    .set_read_timeout(Some(Duration::from_secs(3)))
                                    .unwrap();
                                backend.write_all(&body).unwrap();
                                let mut response = vec![];
                                backend.read_to_end(&mut response).unwrap();
                                let _ = tls.write_all(&response);
                                let _ = tls.flush();
                                tls.conn.send_close_notify();
                                let _ = tls.flush();
                            }
                            Err(error) => eprintln!("isolated TLS handshake/read: {error:?}"),
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
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
pub(super) struct ConnectProxy {
    pub url: String,
    pub headers: Arc<Mutex<Vec<String>>>,
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
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            while !ended.load(std::sync::atomic::Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        client.set_nonblocking(false).unwrap();
                        client
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        client
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let header = String::from_utf8(request(&mut client).unwrap()).unwrap();
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
                        let copy = thread::spawn(move || {
                            let _ = std::io::copy(&mut read_client, &mut write_upstream);
                            let _ = write_upstream.shutdown(std::net::Shutdown::Write);
                        });
                        let _ = std::io::copy(&mut upstream, &mut client);
                        let _ = client.shutdown(std::net::Shutdown::Both);
                        copy.join().unwrap();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url: format!("http://synthetic-user:synthetic-proxy-secret@{address}"),
            headers,
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
