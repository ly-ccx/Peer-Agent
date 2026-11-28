use peer_protocol::{ExecutionResourceScope, SessionExecutionIdentity};
use peer_store::{
    ExecutionResourceStore, HostClaimClosure, HostDispatchScopes, HostFileMaterialization,
    HostResourcePlan, ResourceError, ResourceReservation,
};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::atomic::AtomicBool};
use tempfile::TempDir;
const AT: &str = "2026-11-14T00:00:00.000Z";
fn plan(id: &str, path: &Path) -> HostResourcePlan {
    HostResourcePlan {
        execution: SessionExecutionIdentity {
            plan_id: id.into(),
            session_id: format!("session-{id}"),
            execution_epoch: format!("epoch-{id}"),
            generation: Some("g".into()),
            goal_revision: Some(1),
        },
        workspace_id: id.into(),
        directory: Some(path.to_owned()),
        title: id.into(),
        read_only: false,
    }
}
fn fixture() -> (TempDir, ExecutionResourceStore, HostResourcePlan) {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join("workspace")).unwrap();
    let p = plan("p", &root.path().join("workspace"));
    let s = ExecutionResourceStore::initialize(root.path(), None).unwrap();
    (root, s, p)
}
fn reserve(
    s: &mut ExecutionResourceStore,
    p: &HostResourcePlan,
    scopes: &[ExecutionResourceScope],
) -> Value {
    s.reserve(
        p,
        ResourceReservation {
            host_epoch: "host",
            scopes,
            record_conflict: false,
        },
        AT,
    )
    .unwrap()
}
fn receipt(s: &ExecutionResourceStore, p: &HostResourcePlan, id: &str, unknown: &[&str]) -> Value {
    json!({"receiptId":id,"operationId":id,"execution":p.execution,"admissionClosed":true,"runnerIdle":true,"schedulerIdle":true,"resourceClaims":s.claims_for(p).unwrap().iter().map(|c|json!({"claimId":c["claimId"],"revision":c["revision"]})).collect::<Vec<_>>(),"unknownCalls":unknown,"scope":"managed_execution"})
}

#[test]
fn receipt_staleness_unknown_retention_and_subsequent_admission_are_real_sqlite_state() {
    let (root, mut s, p) = fixture();
    assert_eq!(reserve(&mut s, &p, &[])["allowed"], true);
    let stale = receipt(&s, &p, "stale", &[]);
    s.activate(&p, "host", AT).unwrap();
    assert_eq!(
        s.settle(&p, &stale, &[], AT),
        Err(ResourceError::ReceiptStale)
    );
    let current = receipt(&s, &p, "unknown", &["call"]);
    s.settle(&p, &current, &[], AT).unwrap();
    let rev = s.revision().unwrap();
    s.settle(&p, &current, &[], AT).unwrap();
    assert_eq!(s.revision().unwrap(), rev);
    let other = plan("other", p.directory.as_ref().unwrap());
    assert_eq!(reserve(&mut s, &other, &[])["allowed"], false);
    let claim = s.claims_for(&p).unwrap().pop().unwrap();
    let calls = vec!["call".into()];
    let close = || HostClaimClosure {
        claim_id: claim["claimId"].as_str().unwrap(),
        claim_revision: claim["revision"].as_u64().unwrap(),
        authority_ref: "host-authorized-fixture",
        unknown_calls: &calls,
        proof: "verified_dead",
        resolution: None,
        at: AT,
    };
    let closed = s.close_claim(&p, close()).unwrap();
    assert_eq!(s.close_claim(&p, close()).unwrap(), closed);
    assert_eq!(
        s.retained_unknowns(&p).unwrap()[0]["unknownCalls"],
        json!(["call"])
    );
    drop(s);
    let mut s = ExecutionResourceStore::initialize(root.path(), None).unwrap();
    s.protect(&p, Some("host"), Some("late"), "reconciling", &calls, AT)
        .unwrap();
    assert!(s.claims_for(&p).unwrap().is_empty());
    assert_eq!(reserve(&mut s, &other, &[])["allowed"], true);
}
#[test]
fn open_handles_cannot_be_forged_ended_by_a_stop_or_closure_receipt() {
    let (_root, mut s, p) = fixture();
    reserve(&mut s, &p, &[]);
    s.mark_handle(
        &p,
        &json!({"handleId":"h","toolCallId":"call","state":"active"}),
        AT,
    )
    .unwrap();
    let r = receipt(&s, &p, "stop", &[]);
    assert_eq!(
        s.settle(&p, &r, &[], AT),
        Err(ResourceError::StopUnconfirmed)
    );
    let r = receipt(&s, &p, "unknown", &["call"]);
    s.settle(&p, &r, &[], AT).unwrap();
    assert_eq!(s.unsettled_handles(&p).unwrap().len(), 1);
    let c = s.claims_for(&p).unwrap().pop().unwrap();
    assert_eq!(
        s.close_claim(
            &p,
            HostClaimClosure {
                claim_id: c["claimId"].as_str().unwrap(),
                claim_revision: c["revision"].as_u64().unwrap(),
                authority_ref: "approved",
                unknown_calls: &["call".into()],
                proof: "verified_dead",
                resolution: None,
                at: AT
            }
        ),
        Err(ResourceError::StopUnconfirmed)
    );
}
#[test]
fn reserved_file_claims_recover_with_file_identity_without_partial_activation() {
    let (_root, mut s, p) = fixture();
    let file = p.directory.as_ref().unwrap().join("new.txt");
    let scopes = [ExecutionResourceScope::File {
        path: file.to_str().unwrap().into(),
    }];
    reserve(&mut s, &p, &scopes);
    assert!(s.activate(&p, "host", AT).unwrap());
    assert!(
        s.claims_for(&p)
            .unwrap()
            .iter()
            .all(|c| c["state"] == "active")
    );
    fs::write(&file, "foreign creation").unwrap();
    assert!(!s.activate(&p, "host", AT).unwrap());
    assert_eq!(
        s.claims_for(&p)
            .unwrap()
            .iter()
            .find(|c| c["resourceRef"].as_str().unwrap().starts_with("file:"))
            .unwrap()["identity"],
        "missing"
    );
}
#[test]
fn confirmed_creation_updates_only_its_owned_missing_claim_and_is_idempotent() {
    let (root, mut s, p) = fixture();
    let file = p.directory.as_ref().unwrap().join("created.txt");
    let scopes = [ExecutionResourceScope::File {
        path: file.to_str().unwrap().into(),
    }];
    reserve(&mut s, &p, &scopes);
    s.activate(&p, "host", AT).unwrap();
    fs::write(&file, "actual provider creation").unwrap();
    let identity = peer_store::file_resource(&file, false).unwrap();
    let before = s.claims_for(&p).unwrap();
    let confirm = |s: &mut ExecutionResourceStore, epoch| {
        s.confirm_file_materialization(
            &p,
            HostFileMaterialization {
                host_epoch: epoch,
                identity: &identity,
                tool_call_id: "call-created",
            },
            AT,
        )
    };
    assert_eq!(
        confirm(&mut s, "foreign-host"),
        Err(ResourceError::OwnerUnknown)
    );
    assert_eq!(s.claims_for(&p).unwrap(), before);
    assert_eq!(confirm(&mut s, "host"), Ok(true));
    let after = s.claims_for(&p).unwrap();
    let claim = after
        .iter()
        .find(|c| c["resourceRef"] == identity.resource_ref)
        .unwrap();
    assert_eq!(claim["identity"], identity.identity);
    let previous = before
        .iter()
        .find(|c| c["claimId"] == claim["claimId"])
        .unwrap();
    assert_eq!(
        claim["revision"].as_u64().unwrap(),
        previous["revision"].as_u64().unwrap() + 1
    );
    assert_eq!(confirm(&mut s, "host"), Ok(false));
    assert_eq!(s.claims_for(&p).unwrap(), after);
    assert_eq!(reserve(&mut s, &p, &scopes)["allowed"], true);
    let db = rusqlite::Connection::open(
        root.path()
            .join("project-runtime/execution-resources.sqlite"),
    )
    .unwrap();
    let events:i64 = db.query_row("SELECT count(*) FROM resource_events WHERE resource=? AND operationId='tool-result://call-created'",[&identity.resource_ref],|r|r.get(0)).unwrap();
    assert_eq!(events, 1);
}
#[test]
fn materialization_cannot_refresh_an_existing_inode_or_a_stale_observation() {
    for old_exists in [false, true] {
        let (_root, mut s, p) = fixture();
        let file = p.directory.as_ref().unwrap().join("file.txt");
        if old_exists {
            fs::write(&file, "old").unwrap();
        }
        reserve(
            &mut s,
            &p,
            &[ExecutionResourceScope::File {
                path: file.to_str().unwrap().into(),
            }],
        );
        fs::write(&file, "observed").unwrap();
        let first = peer_store::file_resource(&file, false).unwrap();
        fs::rename(&file, file.with_extension("old")).unwrap();
        fs::write(&file, "foreign replacement").unwrap();
        let before = s.claims_for(&p).unwrap();
        let mut rejected = vec![first];
        if old_exists {
            rejected.push(peer_store::file_resource(&file, false).unwrap());
        }
        for identity in rejected {
            assert_eq!(
                s.confirm_file_materialization(
                    &p,
                    HostFileMaterialization {
                        host_epoch: "host",
                        identity: &identity,
                        tool_call_id: "call-stale"
                    },
                    AT
                ),
                Err(ResourceError::Changed)
            );
            assert_eq!(s.claims_for(&p).unwrap(), before);
        }
    }
}
#[test]
fn protected_released_closed_and_foreign_execution_claims_cannot_be_materialized() {
    for state in [
        "draining",
        "reconciling",
        "unknown",
        "released",
        "closed",
        "foreign",
    ] {
        let (_root, mut s, mut p) = fixture();
        let file = p.directory.as_ref().unwrap().join("file.txt");
        reserve(
            &mut s,
            &p,
            &[ExecutionResourceScope::File {
                path: file.to_str().unwrap().into(),
            }],
        );
        fs::write(&file, "created").unwrap();
        let identity = peer_store::file_resource(&file, false).unwrap();
        match state {
            "draining" | "reconciling" => s
                .protect(&p, Some("host"), Some("op"), state, &[], AT)
                .unwrap(),
            "unknown" => s
                .protect(
                    &p,
                    Some("host"),
                    Some("op"),
                    "reconciling",
                    &["unknown-call".into()],
                    AT,
                )
                .unwrap(),
            "released" => {
                let r = receipt(&s, &p, "stop", &[]);
                s.settle(&p, &r, &[], AT).unwrap();
            }
            "closed" => {
                s.protect(
                    &p,
                    Some("host"),
                    Some("op"),
                    "reconciling",
                    &["unknown-call".into()],
                    AT,
                )
                .unwrap();
                let c = s
                    .claims_for(&p)
                    .unwrap()
                    .into_iter()
                    .find(|c| c["resourceRef"] == identity.resource_ref)
                    .unwrap();
                s.close_claim(
                    &p,
                    HostClaimClosure {
                        claim_id: c["claimId"].as_str().unwrap(),
                        claim_revision: c["revision"].as_u64().unwrap(),
                        authority_ref: "fixture-host-proof",
                        unknown_calls: &["unknown-call".into()],
                        proof: "verified_dead",
                        resolution: None,
                        at: AT,
                    },
                )
                .unwrap();
            }
            "foreign" => p.execution.execution_epoch = "other-epoch".into(),
            _ => unreachable!(),
        }
        let before = s.snapshot().unwrap();
        assert!(
            s.confirm_file_materialization(
                &p,
                HostFileMaterialization {
                    host_epoch: "host",
                    identity: &identity,
                    tool_call_id: "call-protected"
                },
                AT
            )
            .is_err(),
            "{state}"
        );
        assert_eq!(s.snapshot().unwrap(), before);
    }
}
#[test]
fn version_two_migrates_without_losing_unknown_fields_or_reconstructing_a_lost_ledger() {
    let (root, mut s, p) = fixture();
    reserve(&mut s, &p, &[]);
    drop(s);
    let path = root
        .path()
        .join("project-runtime/execution-resources.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    let raw: String = c
        .query_row("SELECT value FROM claims", [], |r| r.get(0))
        .unwrap();
    let mut raw: Value = serde_json::from_str(&raw).unwrap();
    raw["future"] = json!({"opaque":[1,2]});
    c.execute("UPDATE claims SET value=?", [raw.to_string()])
        .unwrap();
    c.execute_batch(
        "DROP TABLE reconciliation_evidence;DROP TABLE resolutions;PRAGMA user_version=2;",
    )
    .unwrap();
    drop(c);
    let mut s = ExecutionResourceStore::initialize(root.path(), None).unwrap();
    assert_eq!(
        s.claims_for(&p).unwrap()[0]["future"],
        json!({"opaque":[1,2]})
    );
    s.activate(&p, "host", AT).unwrap();
    assert_eq!(
        s.claims_for(&p).unwrap()[0]["future"],
        json!({"opaque":[1,2]})
    );
    let missing = TempDir::new().unwrap();
    fs::create_dir_all(missing.path().join("project-runtime/w/coordination-v2")).unwrap();
    fs::write(
        missing
            .path()
            .join("project-runtime/w/coordination-v2/manifest.json"),
        r#"{"minimumWriterVersion":9}"#,
    )
    .unwrap();
    assert!(matches!(
        ExecutionResourceStore::initialize(missing.path(), None),
        Err(ResourceError::Missing)
    ));
    assert!(
        !missing
            .path()
            .join("project-runtime/execution-resources.sqlite")
            .exists()
    );
}
#[test]
fn a_replaced_database_or_inconsistent_indexed_claim_cannot_admit_new_work() {
    let (root, mut s, p) = fixture();
    reserve(&mut s, &p, &[]);
    let path = root
        .path()
        .join("project-runtime/execution-resources.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute("UPDATE claims SET state='released'", []).unwrap();
    drop(c);
    assert_eq!(s.snapshot(), Err(ResourceError::Invalid));
    drop(s);
    let s = ExecutionResourceStore::open_existing(root.path()).unwrap();
    fs::rename(&path, root.path().join("saved.sqlite")).unwrap();
    fs::write(&path, "replacement").unwrap();
    assert_eq!(s.snapshot(), Err(ResourceError::Changed));
    assert_eq!(fs::read(path).unwrap(), b"replacement");
}
#[test]
fn malformed_schema_and_cancelled_initialization_preserve_existing_files() {
    let root = TempDir::new().unwrap();
    assert!(matches!(
        ExecutionResourceStore::initialize(root.path(), Some(&AtomicBool::new(true))),
        Err(ResourceError::Cancelled)
    ));
    assert!(!root.path().join("project-runtime").exists());
    let (root, s, _p) = fixture();
    drop(s);
    let path = root
        .path()
        .join("project-runtime/execution-resources.sqlite");
    let c = rusqlite::Connection::open(&path).unwrap();
    c.execute_batch("CREATE TABLE foreign_data(id TEXT);")
        .unwrap();
    drop(c);
    let before = fs::read(&path).unwrap();
    assert!(matches!(
        ExecutionResourceStore::initialize(root.path(), None),
        Err(ResourceError::Schema)
    ));
    assert_eq!(fs::read(&path).unwrap(), before);
}
#[test]
fn complete_declared_unknowns_narrow_only_to_the_actual_file_and_remain_unknown() {
    let (_root, mut s, p) = fixture();
    let file = p.directory.as_ref().unwrap().join("one.txt");
    fs::write(&file, "retained").unwrap();
    reserve(&mut s, &p, &[]);
    let receipt = receipt(&s, &p, "narrow", &["call"]);
    s.settle(
        &p,
        &receipt,
        &[HostDispatchScopes {
            tool_call_id: "call".into(),
            scopes: vec![ExecutionResourceScope::File {
                path: file.to_str().unwrap().into(),
            }],
        }],
        AT,
    )
    .unwrap();
    let claim = s.claims_for(&p).unwrap().pop().unwrap();
    assert!(claim["resourceRef"].as_str().unwrap().starts_with("file:"));
    assert_eq!(claim["state"], "reconciling");
    assert_eq!(claim["evidenceCalls"], json!(["call"]));
    let other = plan("other", p.directory.as_ref().unwrap());
    assert_eq!(reserve(&mut s, &other, &[])["allowed"], true);
    assert_eq!(
        reserve(
            &mut s,
            &other,
            &[ExecutionResourceScope::File {
                path: file.to_str().unwrap().into()
            }]
        )["allowed"],
        false
    );
}
#[test]
fn invalid_scope_or_oversized_handle_rolls_back_and_the_next_request_is_admitted() {
    let (root, mut s, p) = fixture();
    let bad = ExecutionResourceScope::Directory {
        path: root.path().join("missing").to_str().unwrap().into(),
    };
    assert_eq!(
        s.reserve(
            &p,
            ResourceReservation {
                host_epoch: "host",
                scopes: &[bad],
                record_conflict: false
            },
            AT
        ),
        Err(ResourceError::Scope)
    );
    assert!(s.snapshot().unwrap().is_empty());
    reserve(&mut s, &p, &[]);
    let before = s.snapshot().unwrap();
    assert_eq!(s.mark_handle(&p,&json!({"handleId":"h","toolCallId":"t","state":"active","oversized":"x".repeat(1_048_577)}),AT),Err(ResourceError::Limit));
    assert_eq!(s.snapshot().unwrap(), before);
    let receipt = receipt(&s, &p, "safe-stop", &[]);
    s.settle(&p, &receipt, &[], AT).unwrap();
    assert_eq!(
        reserve(&mut s, &plan("next", p.directory.as_ref().unwrap()), &[])["allowed"],
        true
    );
}
