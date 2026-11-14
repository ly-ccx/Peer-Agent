use peer_store::{AcquireLease, HostIdentity, HostLeaseStore, HostSurface, StoreError};
use std::fs;

fn identity(id: &str, pid: u32) -> HostIdentity {
    HostIdentity::new(id, HostSurface::Tui, pid, "fixture").unwrap()
}

#[test]
fn acquire_renew_takeover_and_stale_handles_preserve_current_owner() {
    let root = tempfile::tempdir().unwrap();
    let store = HostLeaseStore::new(root.path());
    let a = identity("a", 101);
    let b = identity("b", 202);
    let AcquireLease::Acquired {
        mut token,
        took_over: false,
    } = store.acquire("w", &a, 1000).unwrap()
    else {
        panic!("first owner");
    };
    assert_eq!(token.record().heartbeat_at, "1970-01-01T00:00:01.000Z");
    token.heartbeat(6000).unwrap();
    assert!(token.holds().unwrap());
    assert!(matches!(
        store.acquire("w", &b, 25_999).unwrap(),
        AcquireLease::Held(_)
    ));
    let AcquireLease::Acquired {
        token: successor,
        took_over: true,
    } = store.acquire("w", &b, 26_000).unwrap()
    else {
        panic!("stale takeover");
    };
    assert!(!token.holds().unwrap());
    assert_eq!(token.heartbeat(27_000), Err(StoreError::LeaseOwnershipLost));
    assert_eq!(token.release(), Err(StoreError::LeaseOwnershipLost));
    assert_eq!(store.inspect("w").unwrap().unwrap().host_id, "b");
    successor.release().unwrap();
    assert!(matches!(
        store.acquire("w", &a, 28_000).unwrap(),
        AcquireLease::Acquired {
            took_over: false,
            ..
        }
    ));
}

#[test]
fn unknown_fields_survive_heartbeat_and_yield_waits_for_real_drain() {
    let root = tempfile::tempdir().unwrap();
    let store = HostLeaseStore::new(root.path());
    let a = identity("a", 101);
    let b = identity("b", 202);
    let AcquireLease::Acquired { mut token, .. } = store.acquire("w", &a, 1000).unwrap() else {
        panic!("owner");
    };
    let path = root.path().join("project-runtime/w/host.lease");
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["future"] = serde_json::json!({"retained":true});
    fs::write(&path, record.to_string()).unwrap();
    token.heartbeat(6000).unwrap();
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(record["future"]["retained"], true);
    assert!(!store.request_takeover("w", &a, 6000).unwrap());
    assert!(store.request_takeover("w", &b, 6000).unwrap());
    assert!(token.takeover_requested().unwrap());
    assert!(matches!(
        store.acquire("w", &b, 6000).unwrap(),
        AcquireLease::Held(_)
    ));
    // Reading a request does not release the holder or attest execution stopped.
    token.heartbeat(11_000).unwrap();
    assert!(token.holds().unwrap());
    drop(token); // Dropping the storage handle never releases active ownership.
    assert_eq!(store.inspect("w").unwrap().unwrap().host_id, "a");
}

#[test]
fn corrupt_or_future_lease_records_are_preserved_without_takeover() {
    let root = tempfile::tempdir().unwrap();
    let store = HostLeaseStore::new(root.path());
    fs::create_dir_all(root.path().join("project-runtime/w")).unwrap();
    let path = root.path().join("project-runtime/w/host.lease");
    for bytes in [
        "broken",
        r#"{"hostId":"a","surface":"future","pid":1,"acquiredAt":"1970-01-01T00:00:00Z","heartbeatAt":"1970-01-01T00:00:00Z"}"#,
    ] {
        fs::write(&path, bytes).unwrap();
        assert!(matches!(
            store.acquire("w", &identity("b", 2), 99_000),
            Err(StoreError::LeaseCorrupt)
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
    }
    assert!(matches!(
        store.acquire("../outside", &identity("b", 2), 0),
        Err(StoreError::InvalidInput)
    ));
}

#[cfg(unix)]
#[test]
fn lease_symlinks_and_workspace_symlinks_are_not_followed() {
    let root = tempfile::tempdir().unwrap();
    let store = HostLeaseStore::new(root.path());
    fs::create_dir_all(root.path().join("project-runtime/w")).unwrap();
    fs::write(root.path().join("unknown"), "preserve").unwrap();
    std::os::unix::fs::symlink(
        root.path().join("unknown"),
        root.path().join("project-runtime/w/host.lease"),
    )
    .unwrap();
    assert!(matches!(
        store.acquire("w", &identity("b", 2), 99_000),
        Err(StoreError::ReadFailed)
    ));
    std::os::unix::fs::symlink(
        root.path().join("project-runtime/w"),
        root.path().join("project-runtime/alias"),
    )
    .unwrap();
    assert!(matches!(
        store.acquire("alias", &identity("b", 2), 99_000),
        Err(StoreError::ReadFailed)
    ));
    assert_eq!(
        fs::read_to_string(root.path().join("unknown")).unwrap(),
        "preserve"
    );
}

#[test]
fn independent_threads_competing_for_a_free_lease_have_one_owner() {
    for _ in 0..256 {
        let root = tempfile::tempdir().unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (1..=2)
            .map(|pid| {
                let root = root.path().to_owned();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    HostLeaseStore::new(root).acquire(
                        "w",
                        &identity(&format!("host-{pid}"), pid),
                        1000,
                    )
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, AcquireLease::Acquired { .. }))
                .count(),
            1
        );
        assert_eq!(
            results
                .iter()
                .filter(|r| matches!(r, AcquireLease::Held(_)))
                .count(),
            1
        );
    }
}
