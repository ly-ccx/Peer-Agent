use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
struct ServerGuard(Arc<AtomicBool>, Option<std::thread::JoinHandle<()>>);
impl Drop for ServerGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
        if let Some(thread) = self.1.take() {
            let result = thread.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
}
#[tokio::test]
async fn separate_native_owners_reserve_once_before_sending_the_same_refresh_token() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path();
    std::fs::write(home.join(".native-cli-fixture"), "isolated").unwrap();
    std::fs::write(home.join(".synthetic-vault-key"), [17u8; 32]).unwrap();
    let config = json!({"version":2,"channels":[{"id":"group","authMethod":"oauth_chatgpt","oauthConfigured":true}],"models":[{"id":"group::model","groupId":"group","model":"gpt-5.6-luna"}]});
    std::fs::write(home.join("llm-providers.json"), config.to_string()).unwrap();
    let selected = json!({"modelProviderId":"group::model"});
    let helper_path = Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../target/debug/examples/vault-fixture{}",
        std::env::consts::EXE_SUFFIX
    ));
    let make_helper = || HelperClient::new(&helper_path, home, Duration::from_secs(10)).unwrap();
    let cancel = CancellationToken::new();
    let key = "model/group/oauth-tokens";
    make_helper().set(key,&json!({"access":"old","refresh":"one-use-refresh","expires":1,"accountId":"account","opaque":{"preserved":true}}).to_string(),&cancel).await.unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(
        home.join(".native-model-oauth-fixture.json"),
        json!({"modelBaseUrl":base,"tokenUrl":format!("{base}/token")}).to_string(),
    )
    .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let captured = count.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let ended = stop.clone();
    let server = std::thread::spawn(move || {
        while !ended.load(Ordering::Acquire) {
            let (mut socket, _) = match listener.accept() {
                Ok(value) => value,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut header = vec![];
            let mut b = [0];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut b).unwrap();
                header.push(b[0]);
                assert!(header.len() < 16384);
            }
            let header = String::from_utf8(header).unwrap();
            let size = header
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(size < 16384);
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            assert!(
                String::from_utf8(body)
                    .unwrap()
                    .contains("refresh_token=one-use-refresh")
            );
            captured.fetch_add(1, Ordering::AcqRel);
            let body=json!({"access_token":"new","refresh_token":"rotated","expires_in":3600,"account_id":"account"}).to_string();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
        }
    });
    let guard = ServerGuard(stop.clone(), Some(server));
    let left = ModelOAuth::load_with_helper(
        home,
        key,
        "oauth_chatgpt",
        ModelBinding::new(home, &config, &selected).unwrap(),
        make_helper(),
        &cancel,
    )
    .await
    .unwrap();
    let right = ModelOAuth::load_with_helper(
        home,
        key,
        "oauth_chatgpt",
        ModelBinding::new(home, &config, &selected).unwrap(),
        make_helper(),
        &cancel,
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(left.access(&cancel), right.access(&cancel));
    drop(guard);
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    assert_eq!(count.load(Ordering::Acquire), 1);
    let stored = make_helper().get_snapshot(key, &cancel).await.unwrap();
    let value: Value = serde_json::from_str(stored.secret.unwrap().expose()).unwrap();
    assert_eq!(value["access"], "new");
    assert_eq!(value["opaque"], json!({"preserved":true}));
    assert!(value.get("peerModelRefresh").is_none());
}
