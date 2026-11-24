use super::*;
use std::sync::{Arc, Barrier};
fn source(root: &Path) -> DisplaySnapshot {
    let dir = root.join("data/conversations");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.jsonl"), "{\"id\":\"a\"}\n").unwrap();
    fs::write(
        dir.join("a.jsonl"),
        "{\"role\":\"user\",\"content\":\"fact\"}\n",
    )
    .unwrap();
    peer_store::ConversationStore::new(root.join("data"))
        .visit_display("a", None, |_| Ok(()))
        .unwrap()
}
fn spool(text: &str) -> File {
    let mut file = tempfile::tempfile().unwrap();
    file.write_all(text.as_bytes()).unwrap();
    file
}
#[test]
fn concurrent_native_force_publications_cannot_both_replace_the_same_target_generation() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = Arc::new(source(root.path()));
    let path = root.path().join("out.md");
    fs::write(&path, "old").unwrap();
    let first =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    let second =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    let gate = Arc::new(Barrier::new(2));
    let workers = [first, second]
        .into_iter()
        .enumerate()
        .map(|(i, destination)| {
            let snapshot = snapshot.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                let mut input = spool(if i == 0 { "one" } else { "two" });
                gate.wait();
                (
                    i,
                    destination.publish(&snapshot, &mut input, &AtomicBool::new(false)),
                )
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|w| w.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|(_, r)| r.is_ok()).count(), 1);
    let winner = results.iter().find(|(_, r)| r.is_ok()).unwrap().0;
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        if winner == 0 { "one" } else { "two" }
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
}
#[test]
fn publication_uncertainty_retains_the_committed_copy_and_explicit_fresh_force_can_recover() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = source(root.path());
    let path = root.path().join("out.md");
    fs::write(&path, "old").unwrap();
    let destination =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    let result = destination.publish_with_sync(
        &snapshot,
        &mut spool("committed copy"),
        &AtomicBool::new(false),
        |_| Err(io::Error::other("owned sync failure")),
    );
    assert_eq!(
        result.unwrap_err().to_string(),
        "export_publication_unknown"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "committed copy");
    let retry =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    retry
        .publish(
            &snapshot,
            &mut spool("next complete copy"),
            &AtomicBool::new(false),
        )
        .unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "next complete copy");
}
#[cfg(unix)]
#[test]
fn cancelled_lock_wait_cleans_only_its_temp_preserves_the_target_and_admits_a_later_export() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = Arc::new(source(root.path()));
    let path = root.path().join("out.md");
    fs::write(&path, "old").unwrap();
    let destination =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    let directory = File::open(root.path()).unwrap();
    rustix::fs::flock(&directory, rustix::fs::FlockOperation::LockExclusive).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let view = snapshot.clone();
    let worker =
        std::thread::spawn(move || destination.publish(&view, &mut spool("cancelled"), &signal));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while fs::read_dir(root.path()).unwrap().count() == 2 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    cancel.store(true, Ordering::Release);
    let error = worker.join().unwrap().unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    assert_eq!(fs::read_to_string(&path).unwrap(), "old");
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);
    drop(directory);
    Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true)
        .unwrap()
        .publish(&snapshot, &mut spool("later"), &AtomicBool::new(false))
        .unwrap();
    assert_eq!(fs::read_to_string(path).unwrap(), "later");
}
#[test]
fn source_aliases_and_changed_targets_are_preserved() {
    let root = tempfile::tempdir().unwrap();
    let snapshot = source(root.path());
    let path = root.path().join("alias.md");
    let original = root.path().join("data/conversations/a.jsonl");
    fs::hard_link(&original, &path).unwrap();
    let bytes = fs::read(&original).unwrap();
    let destination =
        Destination::inspect(&root.path().join("data"), path.to_str().unwrap(), true).unwrap();
    assert_eq!(
        destination
            .publish(&snapshot, &mut spool("never"), &AtomicBool::new(false))
            .unwrap_err()
            .to_string(),
        "export_target_is_source"
    );
    assert_eq!(fs::read(original).unwrap(), bytes);
    let target = root.path().join("new.md");
    let destination =
        Destination::inspect(&root.path().join("data"), target.to_str().unwrap(), false).unwrap();
    fs::write(&target, "newer owner").unwrap();
    assert!(
        destination
            .publish(&snapshot, &mut spool("never"), &AtomicBool::new(false))
            .is_err()
    );
    assert_eq!(fs::read(target).unwrap(), b"newer owner");
}
