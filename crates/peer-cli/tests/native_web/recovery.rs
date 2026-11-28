use super::*;
fn independent(f: &Fixture) {
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let dir = f.root.path().join("independent-workspace");
    std::fs::create_dir(&dir).unwrap();
    let path = f.root.path().join("goal-plans/p2.json");
    let mut p = get(&path);
    p["targetWorkspacePath"] = json!(dir);
    put(path, &p);
    success(&f.command("exec", "p2").output().unwrap());
}
fn legacy_dir(f: &Fixture) -> std::path::PathBuf {
    let root = f.root.path().join("web-artifacts");
    let date = std::fs::read_dir(&root)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    std::fs::read_dir(date)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path()
}
#[test]
fn native_web_partial_publication_retains_content_reference_and_unknown_without_http_replay() {
    let page = Page::new(vec![http(200, &[], b"retained HTTP observation")], false);
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url})),
        reply_text("Independent work."),
    ]);
    let f = Fixture::new(&server);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_WEB_PUBLICATION_FAULT", "after_content")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("execution_outcome_unknown"));
    let (r, g) = result(&f);
    assert_eq!(r["error"]["code"], "execution_outcome_unknown");
    assert_eq!(r["output"]["reason"], "web_artifact_commit_unknown");
    assert_eq!(g["granted"], true);
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(r["output"]["nativeContentRef"].clone()).unwrap();
    assert_eq!(
        peer_store::ToolArtifactStore::new(f.root.path())
            .read_window("c", &reference, 0, 4096, &|| false)
            .unwrap()
            .bytes,
        b"retained HTTP observation"
    );
    let dir = legacy_dir(&f);
    assert_eq!(
        std::fs::read(dir.join("content.txt")).unwrap(),
        b"retained HTTP observation"
    );
    assert!(!dir.join("metadata.json").exists());
    success(&f.command("recover", "p").output().unwrap());
    let before = f.history();
    let unknown = f.budget(|_| {});
    assert_eq!(unknown["uncertainDispatches"].as_array().unwrap().len(), 1);
    assert!(!f.run().status.success());
    independent(&f);
    assert_eq!(f.budget(|_| {}), unknown);
    assert_eq!(f.history(), before);
    assert_eq!(page.headers.lock().unwrap().len(), 1);
    assert!(!dir.join("metadata.json").exists());
}
#[test]
fn native_web_hard_exit_after_publication_preserves_files_and_unconfirmed_dispatch() {
    let page = Page::new(vec![http(200, &[], b"published before hard exit")], false);
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url})),
        reply_text("Independent work."),
    ]);
    let f = Fixture::new(&server);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "web_fetch")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(77));
    let dir = legacy_dir(&f);
    let content = std::fs::read(dir.join("content.txt")).unwrap();
    let meta = get(dir.join("metadata.json"));
    assert_eq!(content, b"published before hard exit");
    assert!(meta["nativeContentRef"].is_object());
    assert_eq!(f.history().len(), 1);
    f.age_dead_lease();
    assert!(!f.run().status.success());
    success(&f.command("recover", "p").output().unwrap());
    let unknown = f.budget(|_| {});
    assert_eq!(unknown["uncertainDispatches"].as_array().unwrap().len(), 1);
    independent(&f);
    assert_eq!(f.budget(|_| {}), unknown);
    assert_eq!(page.headers.lock().unwrap().len(), 1);
    assert_eq!(get(dir.join("metadata.json")), meta);
    assert_eq!(std::fs::read(dir.join("content.txt")).unwrap(), content);
    assert_eq!(f.history().len(), 1);
}
#[test]
fn native_web_quota_pressure_is_read_only_and_allows_a_later_unrelated_task() {
    let page = Page::new(vec![], false);
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url})),
        reply_text("Quota failure observed."),
        reply_text("Later work."),
    ]);
    let f = Fixture::new(&server);
    let root = f.root.path().join("web-artifacts");
    std::fs::create_dir(&root).unwrap();
    let file = std::fs::File::create(root.join("old-content")).unwrap();
    file.set_len(512 * 1024 * 1024 + 1).unwrap();
    success(&f.run());
    let (r, g) = result(&f);
    assert_eq!(r["error"]["code"], "web_artifact_limit");
    assert_eq!(g["granted"], true);
    assert_eq!(r["evidence"]["dispatchOutcome"], "not_dispatched");
    assert!(page.headers.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(file.metadata().unwrap().len(), 512 * 1024 * 1024 + 1);
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    success(&f.command("exec", "p2").output().unwrap());
}
