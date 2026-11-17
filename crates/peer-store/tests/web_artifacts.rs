use peer_store::WebArtifactStore;
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
};
const UUID: &str = "01234567-89ab-4cde-8f01-23456789abcd";
#[test]
fn published_legacy_files_are_verified_private_and_never_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let store = WebArtifactStore::new(root.path());
    store.check_capacity(&|| false).unwrap();
    assert!(!root.path().join("web-artifacts").exists());
    let meta = json!({"fetchId":UUID,"title":"facts"});
    let p = store
        .publish("2026-11-17", UUID, "saved body\n", &meta, &|| false)
        .unwrap();
    assert_eq!(p.reference, format!("local-web-artifact://{UUID}"));
    let dir = root.path().join("web-artifacts/2026-11-17").join(UUID);
    assert_eq!(
        fs::read_to_string(dir.join("content.txt")).unwrap(),
        "saved body\n"
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(dir.join("metadata.json")).unwrap())
            .unwrap(),
        meta
    );
    assert_eq!(
        fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(dir.join("content.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(
        store
            .publish("2026-11-17", UUID, "overwritten", &meta, &|| false)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(dir.join("content.txt")).unwrap(),
        "saved body\n"
    );
}
#[test]
fn corrupt_root_quota_and_cancellation_preserve_existing_data() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), root.path().join("web-artifacts")).unwrap();
    let s = WebArtifactStore::new(root.path());
    assert!(s.check_capacity(&|| false).is_err());
    assert!(
        s.publish("2026-11-17", UUID, "x", &json!({}), &|| false)
            .is_err()
    );
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    let r = tempfile::tempdir().unwrap();
    fs::create_dir(r.path().join("web-artifacts")).unwrap();
    let file = fs::File::create(r.path().join("web-artifacts/old-content")).unwrap();
    file.set_len(512 * 1024 * 1024 + 1).unwrap();
    let s = WebArtifactStore::new(r.path());
    let e = s.check_capacity(&|| false).unwrap_err();
    assert_eq!(e.code, "web_artifact_limit");
    assert!(!e.effect_possible);
    assert_eq!(file.metadata().unwrap().len(), 512 * 1024 * 1024 + 1);
    let r = tempfile::tempdir().unwrap();
    let s = WebArtifactStore::new(r.path());
    let target = r.path().join("web-artifacts/2026-11-17").join(UUID);
    let e = s
        .publish("2026-11-17", UUID, "retained content", &json!({}), &|| {
            target.join("metadata.json").exists()
        })
        .unwrap_err();
    assert!(e.effect_possible);
    assert_eq!(
        fs::read_to_string(target.join("content.txt")).unwrap(),
        "retained content"
    );
    assert_eq!(fs::metadata(target.join("metadata.json")).unwrap().len(), 0);
}
#[test]
fn directory_replacement_and_content_changes_never_publish_a_success_receipt() {
    for replace_directory in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let s = WebArtifactStore::new(root.path());
        let target = root.path().join("web-artifacts/2026-11-17").join(UUID);
        let changed = std::cell::Cell::new(false);
        let e = s
            .publish(
                "2026-11-17",
                UUID,
                "saved body",
                &json!({"fact":"saved"}),
                &|| {
                    if !changed.get() {
                        if replace_directory
                            && target
                                .join("metadata.json")
                                .metadata()
                                .is_ok_and(|m| m.len() > 0)
                        {
                            changed.set(true);
                            fs::rename(
                                root.path().join("web-artifacts"),
                                root.path().join("held-original"),
                            )
                            .unwrap();
                            fs::create_dir(root.path().join("web-artifacts")).unwrap();
                        } else if !replace_directory
                            && target
                                .join("content.txt")
                                .metadata()
                                .is_ok_and(|m| m.len() > 0)
                        {
                            changed.set(true);
                            fs::write(target.join("content.txt"), "evil! body").unwrap();
                        }
                    }
                    false
                },
            )
            .unwrap_err();
        assert!(changed.get());
        assert!(e.effect_possible);
        assert_eq!(e.code, "web_artifact_changed");
        if replace_directory {
            assert!(
                fs::read_dir(root.path().join("web-artifacts"))
                    .unwrap()
                    .next()
                    .is_none()
            );
            assert_eq!(
                fs::read(
                    root.path()
                        .join("held-original/2026-11-17")
                        .join(UUID)
                        .join("content.txt")
                )
                .unwrap(),
                b"saved body"
            );
        } else {
            assert_eq!(fs::read(target.join("content.txt")).unwrap(), b"evil! body");
            assert!(!target.join("metadata.json").exists());
        }
    }
}
#[test]
fn metadata_and_identity_limits_fail_before_creating_any_directory() {
    let root = tempfile::tempdir().unwrap();
    let s = WebArtifactStore::new(root.path());
    let e = s
        .publish(
            "2026-11-17",
            UUID,
            "body",
            &json!({"large":"x".repeat(256*1024)}),
            &|| false,
        )
        .unwrap_err();
    assert_eq!(e.code, "web_artifact_limit");
    assert!(!e.effect_possible);
    let compact = UUID.replace('-', "");
    let e = s
        .publish("2026-11-17", &compact, "body", &json!({}), &|| false)
        .unwrap_err();
    assert_eq!(e.code, "web_artifact_invalid");
    assert!(!e.effect_possible);
    assert!(!root.path().join("web-artifacts").exists());
}
