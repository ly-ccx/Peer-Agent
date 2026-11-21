#![cfg(feature = "test-fixtures")]
use peer_store::{
    AcquireLease, FenceError, FenceOutcome, FenceStep, HostIdentity, HostLeaseStore, HostSurface,
    LeaseToken, StoreError, protect_coordination_writer, protect_coordination_writer_fixture,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tempfile::TempDir;

fn token(path: &Path) -> String {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(path).unwrap();
    format!(
        "{}:{}:{}:{}:{}",
        m.dev(),
        m.ino(),
        m.len(),
        i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
        i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec())
    )
}
fn directory(root: &TempDir) -> PathBuf {
    root.path().join("project-runtime/w")
}
fn fixture(empty: bool) -> (TempDir, LeaseToken) {
    let root = TempDir::new().unwrap();
    let owner =
        HostIdentity::new("native", HostSurface::Tui, std::process::id(), "fixture").unwrap();
    let AcquireLease::Acquired { token: lease, .. } = HostLeaseStore::new(root.path())
        .acquire("w", &owner, 1000)
        .unwrap()
    else {
        panic!("fixture lease")
    };
    let dir = directory(&root);
    fs::create_dir(dir.join("coordination-v2")).unwrap();
    let legacy = dir.join("coordination.jsonl");
    let version = if empty {
        "missing".into()
    } else {
        fs::write(&legacy, b"opaque retained terminal history\n").unwrap();
        token(&legacy)
    };
    fs::write(dir.join("coordination-v2/manifest.json"),json!({"schemaVersion":2,"minimumReaderVersion":2,"minimumWriterVersion":2,"generation":"g","legacyFile":"coordination.jsonl","legacyVersion":version,"future":{"preserved":true}}).to_string()).unwrap();
    fs::write(dir.join("coordination-v2/head.json"),json!({"generation":"g","legacyVersion":version,"revision":1,"hash":"original-head","future":17}).to_string()).unwrap();
    (root, lease)
}
fn json_file(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

#[test]
fn healthy_promotion_preserves_sources_and_physically_rejects_legacy_append() {
    let (root, lease) = fixture(false);
    let dir = directory(&root);
    let original = fs::read(dir.join("coordination.jsonl")).unwrap();
    let manifest = fs::read(dir.join("coordination-v2/manifest.json")).unwrap();
    assert_eq!(
        protect_coordination_writer(&lease, None).unwrap(),
        FenceOutcome::Promoted
    );
    let intent = json_file(dir.join("coordination-fence.json"));
    let archive = dir.join(intent["archive"].as_str().unwrap());
    assert_eq!(
        fs::read(archive.join("coordination.jsonl")).unwrap(),
        original
    );
    assert_eq!(fs::read(archive.join("manifest.json")).unwrap(), manifest);
    assert_eq!(
        fs::read(dir.join("coordination-v2/baseline.jsonl")).unwrap(),
        original
    );
    assert!(
        fs::OpenOptions::new()
            .append(true)
            .open(dir.join("coordination.jsonl"))
            .is_err()
    );
    let next = json_file(dir.join("coordination-v2/manifest.json"));
    assert_eq!(next["minimumReaderVersion"], 3);
    assert_eq!(next["future"]["preserved"], true);
    let before = fs::read(dir.join("coordination-fence.json")).unwrap();
    assert_eq!(
        protect_coordination_writer(&lease, None).unwrap(),
        FenceOutcome::AlreadyProtected
    );
    assert_eq!(
        fs::read(dir.join("coordination-fence.json")).unwrap(),
        before
    );
}
#[test]
fn all_six_durable_interruption_points_resume_without_rewriting_task_history() {
    for point in [
        FenceStep::Prepared,
        FenceStep::BaselineCopied,
        FenceStep::LegacyArchived,
        FenceStep::WriterFenced,
        FenceStep::HeadPublished,
        FenceStep::Published,
    ] {
        let (root, lease) = fixture(false);
        let dir = directory(&root);
        let original = fs::read(dir.join("coordination.jsonl")).unwrap();
        let failure = protect_coordination_writer_fixture(&lease, None, |step| {
            if step == point {
                Err(StoreError::Cancelled.into())
            } else {
                Ok(())
            }
        });
        assert_eq!(
            failure,
            Err(FenceError::Store(StoreError::Cancelled)),
            "{point:?}"
        );
        assert_eq!(
            protect_coordination_writer(&lease, None).unwrap(),
            FenceOutcome::Promoted,
            "{point:?}"
        );
        assert_eq!(
            fs::read(dir.join("coordination-v2/baseline.jsonl")).unwrap(),
            original
        );
        assert_eq!(
            json_file(dir.join("coordination-fence.json"))["status"],
            "complete"
        );
    }
}
#[test]
fn empty_baseline_is_fenced_without_inventing_history_and_absent_v2_stays_absent() {
    let (root, lease) = fixture(true);
    assert_eq!(
        protect_coordination_writer(&lease, None).unwrap(),
        FenceOutcome::Promoted
    );
    assert_eq!(
        fs::read(directory(&root).join("coordination-v2/baseline.jsonl")).unwrap(),
        b""
    );
    let (root, lease) = fixture(false);
    fs::remove_dir_all(directory(&root).join("coordination-v2")).unwrap();
    assert_eq!(
        protect_coordination_writer(&lease, None).unwrap(),
        FenceOutcome::NoV2Manifest
    );
    assert!(!directory(&root).join("coordination-fence.json").exists());
}
#[test]
fn cancellation_and_lost_ownership_leave_a_supported_resumable_intent() {
    let (root, lease) = fixture(false);
    let dir = directory(&root);
    let cancelled = AtomicBool::new(true);
    assert_eq!(
        protect_coordination_writer(&lease, Some(&cancelled)),
        Err(FenceError::Store(StoreError::Cancelled))
    );
    assert!(!dir.join("coordination-fence.json").exists());
    cancelled.store(false, Ordering::Release);
    let result = protect_coordination_writer_fixture(&lease, Some(&cancelled), |step| {
        if step == FenceStep::Prepared {
            cancelled.store(true, Ordering::Release);
        }
        Ok(())
    });
    assert_eq!(result, Err(FenceError::Store(StoreError::Cancelled)));
    assert!(dir.join("coordination.jsonl").is_file());
    cancelled.store(false, Ordering::Release);
    assert_eq!(
        protect_coordination_writer(&lease, Some(&cancelled)).unwrap(),
        FenceOutcome::Promoted
    );
    let (root, lease) = fixture(false);
    let dir = directory(&root);
    let path = dir.join("host.lease");
    let mut other = json_file(&path);
    other["hostId"] = "other".into();
    fs::write(&path, other.to_string()).unwrap();
    assert_eq!(
        protect_coordination_writer(&lease, None),
        Err(FenceError::Store(StoreError::LeaseOwnershipLost))
    );
    assert!(!dir.join("coordination-fence.json").exists());
}
#[test]
fn new_head_or_changed_baseline_is_not_erased_by_resuming_old_intent() {
    for mutate_head in [true, false] {
        let (root, lease) = fixture(false);
        let dir = directory(&root);
        assert!(
            protect_coordination_writer_fixture(&lease, None, |step| {
                if step == FenceStep::Published {
                    Err(StoreError::Cancelled.into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        let path = if mutate_head {
            dir.join("coordination-v2/head.json")
        } else {
            dir.join("coordination-v2/baseline.jsonl")
        };
        if mutate_head {
            let mut head = json_file(&path);
            head["revision"] = 99.into();
            fs::write(&path, head.to_string()).unwrap();
        } else {
            fs::write(&path, "changed source").unwrap();
        }
        let changed = fs::read(&path).unwrap();
        assert_eq!(
            protect_coordination_writer(&lease, None),
            Err(FenceError::Changed)
        );
        assert_eq!(fs::read(path).unwrap(), changed);
    }
}
#[test]
fn unsupported_schema_corrupt_seal_symlink_and_changed_legacy_fail_closed() {
    for case in 0..4 {
        let (root, lease) = fixture(false);
        let dir = directory(&root);
        let manifest_path = dir.join("coordination-v2/manifest.json");
        match case {
            0 => {
                let mut m = json_file(&manifest_path);
                m["minimumReaderVersion"] = 99.into();
                m["minimumWriterVersion"] = 99.into();
                fs::write(&manifest_path, m.to_string()).unwrap();
            }
            1 => fs::write(dir.join("coordination-v2/legacy-seal.json"), b"{bad}").unwrap(),
            2 => {
                let outside = dir.join("outside");
                fs::write(&outside, b"preserve").unwrap();
                std::os::unix::fs::symlink(&outside, dir.join("coordination-v2/baseline.jsonl"))
                    .unwrap();
            }
            _ => fs::write(dir.join("coordination.jsonl"), b"new effect unknown\n").unwrap(),
        }
        let before = fs::read(dir.join("coordination.jsonl")).unwrap();
        let metadata = fs::read(&manifest_path).unwrap();
        assert!(protect_coordination_writer(&lease, None).is_err());
        assert_eq!(fs::read(dir.join("coordination.jsonl")).unwrap(), before);
        assert_eq!(fs::read(manifest_path).unwrap(), metadata);
    }
}

#[test]
fn late_foreign_head_or_higher_writer_floor_is_preserved_during_promotion() {
    for raise_floor in [true, false] {
        let (root, lease) = fixture(false);
        let dir = directory(&root);
        let target = dir.join(if raise_floor {
            "coordination-v2/manifest.json"
        } else {
            "coordination-v2/head.json"
        });
        let result = protect_coordination_writer_fixture(&lease, None, |step| {
            if step == FenceStep::HeadPublished {
                let mut current = json_file(&target);
                if raise_floor {
                    current["minimumReaderVersion"] = 12.into();
                    current["minimumWriterVersion"] = 12.into();
                } else {
                    current["revision"] = 99.into();
                }
                fs::write(&target, current.to_string()).unwrap();
            }
            Ok(())
        });
        assert_eq!(result, Err(FenceError::Changed));
        let retained = json_file(&target);
        if raise_floor {
            assert_eq!(retained["minimumWriterVersion"], 12);
        } else {
            assert_eq!(retained["revision"], 99);
        }
        assert_eq!(
            json_file(dir.join("coordination-fence.json"))["status"],
            "prepared"
        );
    }
}

#[test]
fn ownership_loss_after_intent_does_not_move_the_old_journal() {
    let (root, lease) = fixture(false);
    let dir = directory(&root);
    let source = fs::read(dir.join("coordination.jsonl")).unwrap();
    let result = protect_coordination_writer_fixture(&lease, None, |step| {
        if step == FenceStep::Prepared {
            let path = dir.join("host.lease");
            let mut current = json_file(&path);
            current["hostId"] = "new-owner".into();
            fs::write(path, current.to_string()).unwrap();
        }
        Ok(())
    });
    assert_eq!(
        result,
        Err(FenceError::Store(StoreError::LeaseOwnershipLost))
    );
    assert_eq!(fs::read(dir.join("coordination.jsonl")).unwrap(), source);
    assert!(!dir.join("coordination-v2/baseline.jsonl").exists());
    assert_eq!(
        json_file(dir.join("coordination-fence.json"))["status"],
        "prepared"
    );
    assert_eq!(json_file(dir.join("host.lease"))["hostId"], "new-owner");
}
