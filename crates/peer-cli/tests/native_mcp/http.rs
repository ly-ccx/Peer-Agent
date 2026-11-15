//! Bounded local HTTP fixtures for both distinct MCP transports.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
pub(super) struct Http {
    pub url: String,
    pub requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn read(s: &mut TcpStream) -> Option<(String, Value)> {
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    s.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut bytes = Vec::new();
    let mut b = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() > 32768 {
            return None;
        }
        s.read_exact(&mut b).ok()?;
        bytes.push(b[0]);
    }
    let headers = String::from_utf8(bytes).ok()?;
    let len = headers
        .lines()
        .find_map(|s| {
            s.to_lowercase()
                .strip_prefix("content-length:")
                .and_then(|n| n.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if len > 262144 {
        return None;
    }
    let mut bytes = vec![0; len];
    s.read_exact(&mut bytes).ok()?;
    Some((
        headers,
        if len == 0 {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).ok()?
        },
    ))
}
fn result(v: &Value) -> Value {
    json!({"jsonrpc":"2.0","id":v["id"],"result":if v["method"]=="initialize"{json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"native-http-fixture","version":"1"}})}else{json!({"content":[{"type":"text","text":"native HTTP MCP fact"}],"extra":{"preserved":true}})}})
}
impl Http {
    pub fn new(legacy: bool, sse: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let (sender, receiver) = std::sync::mpsc::sync_channel::<String>(8);
        let receiver = Arc::new(Mutex::new(receiver));
        let worker = thread::spawn(move || {
            let mut clients = Vec::new();
            while !stopped.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        let stop = stopped.clone();
                        let captured = captured.clone();
                        let sender = sender.clone();
                        let receiver = receiver.clone();
                        clients.push(thread::spawn(move||{
            let Some((headers,v))=read(&mut socket) else{return};captured.lock().unwrap().push((headers.clone(),v.clone()));
            if headers.starts_with("GET ") {
                let _=write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\nevent: endpoint\ndata: /rpc\n\n");let _=socket.flush();
                while !stop.load(Ordering::Acquire){match receiver.lock().unwrap().recv_timeout(Duration::from_millis(50)){Ok(body)=>{if write!(socket,"event: message\ndata: {body}\n\n").and_then(|_|socket.flush()).is_err(){break}},Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{},_=>break}}
            }else if legacy {
                if !v["id"].is_null(){let _=sender.send(result(&v).to_string());}
                let _=write!(socket,"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            }else if v["id"].is_null(){let _=write!(socket,"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");}
            else {let body=result(&v).to_string();let(body,kind)=if sse{(format!("event: message\r\ndata: {body}\r\n\r\n"),"text/event-stream")}else{(body,"application/json")};let _=write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {kind}\r\nMcp-Session-Id: native-fixture-session\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());}
        }));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
            for client in clients {
                assert!(client.join().is_ok());
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Http {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                assert!(result.is_ok())
            }
        }
    }
}
