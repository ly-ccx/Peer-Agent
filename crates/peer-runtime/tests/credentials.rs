#![cfg(feature = "test-fixtures")]
use peer_runtime::{
    CancellationToken,
    credentials::{CredentialError, HelperClient},
};
use std::{fs, path::Path, sync::Arc, time::Duration};

fn fixture(deadline: Duration) -> (tempfile::TempDir, HelperClient) {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join(".native-cli-fixture"), "synthetic only").unwrap();
    let client = HelperClient::new(
        Path::new(env!("CARGO_BIN_EXE_helper-test-fixture")),
        root.path(),
        deadline,
    )
    .unwrap();
    (root, client)
}
fn pids(root: &Path) -> Vec<u32> {
    fs::read_dir(root)
        .unwrap()
        .filter_map(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix("pid-"))
                .and_then(|id| id.parse().ok())
        })
        .collect()
}
async fn started(root: &Path, count: usize) -> Vec<u32> {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let ids = pids(root);
            if ids.len() >= count {
                return ids;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("fixture started")
}
async fn assert_reaped(ids: &[u32]) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let alive = ids.iter().any(|id| {
                std::process::Command::new("/bin/kill")
                    .args(["-0", &id.to_string()])
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            });
            if !alive {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("helper killed and reaped");
}

#[tokio::test]
async fn native_v1_roundtrip_and_missing_secret_are_distinct() {
    let (root, client) = fixture(Duration::from_secs(2));
    let cancel = CancellationToken::new();
    client.ping(&cancel).await.unwrap();
    assert!(
        client
            .get("model/provider/api-key", &cancel)
            .await
            .unwrap()
            .is_none()
    );
    client
        .set("model/provider/api-key", "中文\nsynthetic-secret", &cancel)
        .await
        .unwrap();
    assert_eq!(
        client
            .get("model/provider/api-key", &cancel)
            .await
            .unwrap()
            .unwrap()
            .expose(),
        "中文\nsynthetic-secret"
    );
    assert!(
        client
            .delete("model/provider/api-key", &cancel)
            .await
            .unwrap()
    );
    assert!(
        !client
            .delete("model/provider/api-key", &cancel)
            .await
            .unwrap()
    );
    assert_reaped(&pids(root.path())).await;
}

#[tokio::test]
async fn invalid_keys_and_escaped_secret_budget_are_rejected_before_spawn() {
    let (root, client) = fixture(Duration::from_secs(2));
    let cancel = CancellationToken::new();
    for key in [
        "../bad",
        "model/provider/a/b",
        "model/a../api-key",
        "model//api-key",
    ] {
        assert!(matches!(
            client.get(key, &cancel).await,
            Err(CredentialError::InvalidKey)
        ));
    }
    assert!(matches!(
        client
            .set("model/a/api-key", &"\0".repeat(256 * 1024), &cancel)
            .await,
        Err(CredentialError::InvalidSecret)
    ));
    cancel.cancel();
    assert_eq!(client.ping(&cancel).await, Err(CredentialError::Cancelled));
    assert!(pids(root.path()).is_empty());
}

#[tokio::test]
async fn failure_modes_redact_secret_and_do_not_poison_later_requests() {
    let (root, client) = fixture(Duration::from_secs(2));
    let cancel = CancellationToken::new();
    for (mode, expected) in [
        ("stdout-flood", CredentialError::ResponseLimit),
        ("stderr-flood", CredentialError::ResponseLimit),
        ("version", CredentialError::ResponseInvalid),
        ("invalid", CredentialError::ResponseInvalid),
        ("error", CredentialError::SecureStorageUnavailable),
        ("status", CredentialError::HelperRejected),
        ("nodes", CredentialError::ResponseInvalid),
    ] {
        fs::write(root.path().join("mode"), mode).unwrap();
        let error = client
            .get("model/a/api-key", &cancel)
            .await
            .err()
            .expect("must fail");
        assert_eq!(error, expected, "mode {mode}");
        assert!(!format!("{error:?} {error}").contains("synthetic-secret"));
        assert_reaped(&pids(root.path())).await;
        fs::write(root.path().join("mode"), "good").unwrap();
        client.ping(&cancel).await.unwrap();
    }
}

#[tokio::test]
async fn deadline_kills_reaps_and_restores_next_admission() {
    let (root, client) = fixture(Duration::from_millis(150));
    fs::write(root.path().join("mode"), "sleep").unwrap();
    assert_eq!(
        client.ping(&CancellationToken::new()).await,
        Err(CredentialError::Timeout)
    );
    assert_reaped(&pids(root.path())).await;
    fs::write(root.path().join("mode"), "good").unwrap();
    client.ping(&CancellationToken::new()).await.unwrap();
}

#[tokio::test]
async fn cancellation_and_concurrency_gate_are_bounded_and_recoverable() {
    let (root, client) = fixture(Duration::from_secs(2));
    let client = Arc::new(client);
    fs::write(root.path().join("mode"), "sleep").unwrap();
    let cancel = CancellationToken::new();
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let client = client.clone();
        let cancel = cancel.clone();
        tasks.push(tokio::spawn(async move { client.ping(&cancel).await }));
    }
    let ids = started(root.path(), 4).await;
    assert_eq!(
        client.ping(&CancellationToken::new()).await,
        Err(CredentialError::Busy)
    );
    assert_eq!(pids(root.path()).len(), 4);
    cancel.cancel();
    for task in tasks {
        assert_eq!(task.await.unwrap(), Err(CredentialError::Cancelled));
    }
    assert_reaped(&ids).await;
    fs::write(root.path().join("mode"), "good").unwrap();
    client.ping(&CancellationToken::new()).await.unwrap();
}

#[tokio::test]
async fn aborting_the_caller_cleans_up_the_native_child() {
    let (root, client) = fixture(Duration::from_secs(2));
    let client = Arc::new(client);
    fs::write(root.path().join("mode"), "sleep").unwrap();
    let caller = {
        let client = client.clone();
        tokio::spawn(async move { client.ping(&CancellationToken::new()).await })
    };
    let ids = started(root.path(), 1).await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert_reaped(&ids).await;
    fs::write(root.path().join("mode"), "good").unwrap();
    client.ping(&CancellationToken::new()).await.unwrap();
}
