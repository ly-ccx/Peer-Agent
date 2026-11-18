use super::*;

#[test]
fn actual_held_store_lock_denies_claim_without_minting_an_owner_or_changing_source() {
    let (root, store, id) = seed();
    let index = root.path().join("conversations/index.jsonl");
    let before = fs::read(&index).unwrap();
    let held = peer_store::DirectoryLock::acquire(&index, Duration::from_secs(1), None).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "claim_child", "--ignored"])
        .env("PEER_EXECUTION_TEST_ROOT", root.path())
        .env("PEER_EXECUTION_TEST_ID", &id)
        .env("PEER_EXECUTION_TEST_CHILD", "blocked-timeout")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("ready-blocked-timeout").exists() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!(
                "claim child did not reach admission: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        assert!(child.try_wait().unwrap().is_none());
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.path().join("go"), "go").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let out = child.wait_with_output().unwrap();
            panic!(
                "bounded claim did not return: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        fs::read_to_string(root.path().join("result-blocked-timeout")).unwrap(),
        "blocked"
    );
    assert_eq!(fs::read(&index).unwrap(), before);
    assert!(store.read_conversation_execution(&id).unwrap().is_none());
    held.check_owned().unwrap();
    drop(held);
    let mut owner = claim(&store, &id, "fresh-after-lock-release");
    stop(&store, &mut owner);
    assert!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .permits_new_run()
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
#[ignore = "subprocess fixture only"]
fn empty_claim_child() {
    let root = std::env::var_os("PEER_RECOVERY_TEST_ROOT").unwrap();
    let id = std::env::var("PEER_RECOVERY_TEST_ID").unwrap();
    let store = ConversationStore::new(&root);
    let history = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let error = match store.claim_conversation_execution(
        &history,
        &NewConversationExecution {
            stream_id: "uncertain-empty",
            engine: "peer-native",
            owner: &owner(),
            attribution: &json!({"id":"uncertain-empty"}),
            at: AT,
        },
        None,
    ) {
        Ok(_) => panic!("fault did not return uncertain"),
        Err(e) => e,
    };
    assert_eq!(error.error(), StoreError::CommitUncertain);
    let cleanup = error
        .into_cleanup()
        .expect("genuine original empty claim retained");
    let root = Path::new(&root);
    let foreign = std::env::var("PEER_RECOVERY_TEST_FOREIGN").as_deref() == Ok("true");
    if foreign {
        let mut metadata = index(root);
        metadata["runtimeExecution"]["unknownUsage"] = json!(true);
        write_index(root, &metadata);
        let bytes = fs::read(root.join("conversations/index.jsonl")).unwrap();
        assert_eq!(
            cleanup.close_unstarted(&store, AT),
            Err(StoreError::ExecutionChanged)
        );
        assert_eq!(
            fs::read(root.join("conversations/index.jsonl")).unwrap(),
            bytes
        );
    } else {
        cleanup.close_unstarted(&store, AT).unwrap();
        assert!(
            store
                .read_conversation_execution(&id)
                .unwrap()
                .unwrap()
                .permits_new_run()
        );
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn genuine_empty_claim_cleanup_rejects_foreign_control_and_never_creates_dispatch_authority() {
    for foreign in [false, true] {
        let (root, _store, id) = seed();
        fs::write(root.path().join(".native-cli-fixture"), "isolated").unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "recovery::empty_claim_child", "--ignored"])
            .env("PEER_RECOVERY_TEST_ROOT", root.path())
            .env("PEER_RECOVERY_TEST_ID", &id)
            .env("PEER_RECOVERY_TEST_FOREIGN", foreign.to_string())
            .env("PEER_CONVERSATION_EXECUTION_FAULT", "uncertain_claim")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!root.path().join("usage/requests.jsonl").exists());
    }
}

#[test]
fn recovery_binds_complete_control_and_actual_directory_without_issuing_dispatch_authority() {
    let (root, store, id) = seed();
    let mut normal = claim(&store, &id, "stream");
    store
        .prepare_conversation_tool(&mut normal, &call(), AT, None)
        .unwrap();
    let mut recovery = store.try_conversation_recovery(&id).unwrap();
    assert!(matches!(
        store.try_conversation_recovery(&id),
        Err(StoreError::LockBusy)
    ));
    let original = recovery.current(&store).unwrap();
    let mut meta = index(root.path());
    meta["runtimeExecution"]["unknownUsage"] = json!(true); // same revision, uncooperative writer
    write_index(root.path(), &meta);
    assert_eq!(
        recovery.close_admission(&store, AT),
        Err(StoreError::ExecutionChanged)
    );
    assert_eq!(index(root.path())["runtimeExecution"]["unknownUsage"], true);
    meta["runtimeExecution"] = json!(original);
    write_index(root.path(), &meta);
    let old = root.path().join("retained-conversations");
    fs::rename(root.path().join("conversations"), &old).unwrap();
    fs::create_dir(root.path().join("conversations")).unwrap();
    for entry in fs::read_dir(&old).unwrap() {
        let entry = entry.unwrap();
        fs::copy(
            entry.path(),
            root.path().join("conversations").join(entry.file_name()),
        )
        .unwrap();
    }
    assert_eq!(
        recovery.close_admission(&store, AT),
        Err(StoreError::ExecutionChanged)
    );
    assert_eq!(index(root.path())["runtimeExecution"], json!(original));
}

#[test]
fn recovery_closes_dispatch_once_and_bills_known_usage_without_clearing_unknown() {
    let (_root, store, id) = seed();
    let mut normal = claim(&store, &id, "stream");
    store
        .observe_conversation_usage(&mut normal, &usage(12, 4, 1), false, AT)
        .unwrap();
    store
        .prepare_conversation_tool(&mut normal, &call(), AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(&mut normal, "call", AT, None)
        .unwrap();
    let mut recovery = store.try_conversation_recovery(&id).unwrap();
    recovery.close_admission(&store, AT).unwrap();
    let closed = recovery.current(&store).unwrap();
    assert_eq!(closed.pending_tools[0].phase, Dispatch::OutcomeUnknown);
    recovery.close_admission(&store, AT).unwrap();
    assert_eq!(recovery.current(&store).unwrap(), closed);
    assert!(recovery.commit_usage(&store, AT).unwrap().is_some());
    recovery.finish_stop(&store, AT).unwrap();
    let settled = recovery.current(&store).unwrap();
    assert!(!settled.permits_new_run());
    assert_eq!(settled.phase, Phase::RecoveryRequired);
    assert!(settled.usage_committed && settled.stop.is_some());
    recovery.finish_stop(&store, AT).unwrap();
    assert!(recovery.commit_usage(&store, AT).unwrap().is_none());
    assert_eq!(recovery.current(&store).unwrap(), settled);
}

#[test]
#[ignore]
fn recovery_lock_child() {
    let root = std::env::var_os("PEER_RECOVERY_TEST_ROOT").unwrap();
    let id = std::env::var("PEER_RECOVERY_TEST_ID").unwrap();
    let store = ConversationStore::new(&root);
    let guard = store.try_conversation_recovery(&id).unwrap();
    fs::write(Path::new(&root).join("recovery-ready"), "owned").unwrap();
    loop {
        std::hint::black_box(&guard);
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn actual_recovery_flock_excludes_other_processes_and_owner_death_releases_it() {
    let (root, store, id) = seed();
    let _normal = claim(&store, &id, "stream");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "recovery::recovery_lock_child", "--ignored"])
        .env("PEER_RECOVERY_TEST_ROOT", root.path())
        .env("PEER_RECOVERY_TEST_ID", &id)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("recovery-ready").exists() {
        assert!(child.try_wait().unwrap().is_none());
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("recovery child did not acquire its FD guard");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(matches!(
        store.try_conversation_recovery(&id),
        Err(StoreError::LockBusy)
    ));
    child.kill().unwrap();
    child.wait().unwrap();
    assert!(store.try_conversation_recovery(&id).is_ok());
}
