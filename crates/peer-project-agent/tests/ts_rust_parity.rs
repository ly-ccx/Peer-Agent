use peer_project_agent::{
    BotProfileStore, ConversationSearchDocument, ConversationSearchIndex, CreateBotProfile,
    InteractiveResultStore, MemoryItem, PublishInteractiveRequest, STALL_WINDOW_MS,
    SameCauseAssessment, StallAssessment, WatchSessionFacts, assess_same_cause, assess_stall,
    build_cleanup_expected_digest, collect_conversation_search_documents, memory_conflict_decision,
    normalize_user_upload, stable_failure_class,
};
use peer_protocol::interactive_result::{
    InteractiveAvailability, InteractiveOwner, InteractiveResultReference, InteractiveResultSource,
};
use peer_store::{
    InteractiveCleanupRequest, read_interactive_cleanup_receipt, read_interactive_result,
};
use serde_json::{Map, Value, json};
use std::{path::Path, process::Command};
use tempfile::tempdir;

fn run_node_json(script: &str, envs: &[(&str, &str)]) -> Value {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut cmd = Command::new("node");
    cmd.arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .current_dir(&repo_root);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("spawn node for TS parity check");
    assert!(
        out.status.success(),
        "node exited {}:\nSTDOUT:\n{}\nSTDERR:\n{}",
        out.status,
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8(out.stdout).expect("node utf8 stdout");
    serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("invalid JSON from node ({e}):\n{stdout}"))
}

#[test]
fn ts_rust_parity_interactive_results_cross_read_write_and_cleanup() {
    let dir = tempdir().unwrap();
    let data_home = dir.path();
    let data_home_str = data_home.to_str().unwrap();
    let ws_id = "ws-parity-1";
    let conv_id = "conv-parity-1";

    BotProfileStore::new(data_home)
        .create(&CreateBotProfile {
            workspace_id: ws_id,
            display_name: "Parity Bot",
            agent_conversation_id: conv_id,
            managed: false,
            avatar_salt: "ws-parity-1",
        })
        .unwrap();

    let store = InteractiveResultStore::new(data_home);
    let owner = InteractiveOwner {
        workspace_id: ws_id.into(),
        conversation_id: conv_id.into(),
    };

    // (A) Rust write + reconcile -> TS readLocalInteractiveText AND Rust peer_store read_interactive_result
    let rust_pub = store
        .commit_publication(
            &PublishInteractiveRequest {
                owner: owner.clone(),
                source: InteractiveResultSource {
                    conversation_id: "conv-worker-rust".into(),
                    plan_id: "plan-rust-1".into(),
                    session_id: "sess-rust-1".into(),
                    tool_call_id: "call-rust-pub-1".into(),
                    execution_epoch: Some("epoch-rust-1".into()),
                },
                publication_kind: "create".into(),
                base: None,
                title: "Rust Latency Chart".into(),
                text_fallback: "p50 = 12ms\np95 = 24ms".into(),
                program: "root = Text(\"p50=12ms\")".into(),
                bindings: json!({"p50": 12, "p95": 24}),
                provenance: vec![],
                data_level: "D1_internal".into(),
                grant_id: "grant-rust-1".into(),
                stream_id: None,
            },
            true,
        )
        .unwrap();
    let reconciled = store.reconcile_pending(&owner).unwrap();
    assert_eq!(reconciled.len(), 1);
    let rust_ref: InteractiveResultReference =
        serde_json::from_value(rust_pub["reference"].clone()).unwrap();
    let rust_ref_json = serde_json::to_string(&rust_ref).unwrap();

    let ts_read_a = run_node_json(
        r#"
        import { readLocalInteractiveText } from './packages/runtime-node/src/interactive-results/text-reader.mjs';
        const ref = JSON.parse(process.env.REF_JSON);
        const out = readLocalInteractiveText(process.env.DATA_HOME, ref);
        console.log(JSON.stringify(out));
        "#,
        &[("DATA_HOME", data_home_str), ("REF_JSON", &rust_ref_json)],
    );
    let rust_read_a = read_interactive_result(data_home, &rust_ref).unwrap();
    assert_eq!(ts_read_a["availability"], "available");
    assert_eq!(rust_read_a.availability, InteractiveAvailability::Available);
    assert_eq!(
        ts_read_a["ref"].as_str(),
        Some(rust_read_a.locator.as_str())
    );
    assert_eq!(
        ts_read_a["title"].as_str(),
        Some(rust_read_a.title.as_str())
    );
    assert_eq!(
        ts_read_a["textFallback"].as_str(),
        Some(rust_read_a.text_fallback.text.as_str())
    );
    assert_eq!(
        ts_read_a["dataLevel"].as_str(),
        rust_read_a.data_level.as_deref()
    );
    assert_eq!(
        ts_read_a["truncated"].as_bool(),
        Some(rust_read_a.truncated)
    );
    assert_eq!(
        ts_read_a["contentSchemaVersion"].as_u64(),
        rust_read_a.content_schema_version
    );
    assert_eq!(
        ts_read_a["libraryVersion"].as_str(),
        rust_read_a.library_version.as_deref()
    );

    // (B) TS write + markIndexed -> Rust peer_store::read_interactive_result & InteractiveResultStore::get_version
    let ts_write = run_node_json(
        r#"
        import path from 'node:path';
        import { createInteractiveResultStore } from './packages/runtime-node/src/interactive-results/store.mjs';
        import { jsonDigest } from './packages/runtime-node/src/interactive-results/storage.mjs';
        const owner = { workspaceId: process.env.WS_ID, conversationId: process.env.CONV_ID };
        const source = {
          conversationId: 'conv-worker-ts',
          planId: 'plan-ts-1',
          sessionId: 'sess-ts-1',
          toolCallId: 'call-ts-pub-1',
          executionEpoch: 'epoch-ts-1',
        };
        const title = 'TS Matrix Result';
        const textFallback = 'Row 1: throughput = 999 req/s';
        const program = 'root = Table("Metrics", [], @Data("rows"), "k")';
        const bindings = { rows: [{ k: 'throughput', v: 999 }] };
        const specHash = jsonDigest({ schemaVersion: 1, program, title });
        const stateSchemaHash = jsonDigest({});
        const draft = { publication: { kind: 'create' }, title, textFallback, program, bindings };
        const content = {
          schemaVersion: 1,
          libraryVersion: '1.0.0',
          title,
          textFallback,
          program,
          specHash,
          stateSchemaHash,
          stateSchema: {},
          initialValues: {},
          bindings,
        };
        const store = createInteractiveResultStore({
          rootDir: path.join(process.env.DATA_HOME, 'project-runtime'),
          assertCompatibility: () => true,
        });
        try {
          const committed = store.commitPublication({
            owner,
            source,
            draft,
            content,
            provenance: [],
            dataLevel: 'D1_internal',
            grant: { granted: true, toolCallId: source.toolCallId, grantId: 'grant-ts-1' },
          }, () => true);
          const published = store.markIndexed(committed.callRef, committed.indexEntry, () => true);
          console.log(JSON.stringify({
            reference: published.reference,
            locator: published.metadata.artifactRef,
            title,
            textFallback,
            dataLevel: published.metadata.dataLevel,
          }));
        } finally {
          store.close();
        }
        "#,
        &[
            ("DATA_HOME", data_home_str),
            ("WS_ID", ws_id),
            ("CONV_ID", conv_id),
        ],
    );
    let ts_ref: InteractiveResultReference =
        serde_json::from_value(ts_write["reference"].clone()).unwrap();
    let rust_read_ts = read_interactive_result(data_home, &ts_ref).unwrap();
    assert_eq!(
        rust_read_ts.availability,
        InteractiveAvailability::Available
    );
    assert_eq!(rust_read_ts.locator, ts_write["locator"].as_str().unwrap());
    assert_eq!(rust_read_ts.title, ts_write["title"].as_str().unwrap());
    assert_eq!(
        rust_read_ts.text_fallback.text,
        ts_write["textFallback"].as_str().unwrap()
    );
    assert_eq!(
        rust_read_ts.data_level.as_deref(),
        ts_write["dataLevel"].as_str()
    );
    let rust_store_version = store.get_version(&ts_ref, false).unwrap();
    assert_eq!(rust_store_version["publicationStatus"], "published");
    assert_eq!(rust_store_version["content"]["title"], "TS Matrix Result");

    // (C) Rust cleanup tombstone -> TS readLocalInteractiveText & readReceipt AND Rust readReceipt
    let expected_digest = build_cleanup_expected_digest(&rust_ref, "parity-clean").unwrap();
    let cleaned_at = "2026-11-20T12:00:00.000Z";
    let rust_receipt = store
        .cleanup_result(
            &rust_ref,
            "req-parity-clean",
            &expected_digest,
            cleaned_at,
            true,
        )
        .unwrap();

    let ts_clean = run_node_json(
        r#"
        import path from 'node:path';
        import { readLocalInteractiveText } from './packages/runtime-node/src/interactive-results/text-reader.mjs';
        import { createInteractiveResultStore } from './packages/runtime-node/src/interactive-results/store.mjs';
        import { createInteractiveRetention } from './packages/runtime-node/src/interactive-results/retention.mjs';
        const ref = JSON.parse(process.env.REF_JSON);
        const textOut = readLocalInteractiveText(process.env.DATA_HOME, ref);
        const resultStore = createInteractiveResultStore({ rootDir: path.join(process.env.DATA_HOME, 'project-runtime') });
        try {
          const retention = createInteractiveRetention({ resultStore, assertOwner: () => true });
          const receipt = retention.readReceipt({
            reference: ref,
            requestId: 'req-parity-clean',
            expectedDigest: process.env.EXPECTED_DIGEST,
          });
          console.log(JSON.stringify({ textOut, receipt }));
        } finally {
          resultStore.close();
        }
        "#,
        &[
            ("DATA_HOME", data_home_str),
            ("REF_JSON", &rust_ref_json),
            ("EXPECTED_DIGEST", &expected_digest),
        ],
    );
    let rust_cleaned = read_interactive_result(data_home, &rust_ref).unwrap();
    assert_eq!(rust_cleaned.availability, InteractiveAvailability::Cleaned);
    assert_eq!(ts_clean["textOut"]["availability"], "cleaned");
    assert_eq!(
        ts_clean["receipt"]["receiptDigest"],
        rust_receipt["receiptDigest"]
    );
    assert_eq!(ts_clean["receipt"]["requestId"], "req-parity-clean");
    assert_eq!(ts_clean["receipt"]["expectedDigest"], expected_digest);
    assert_eq!(ts_clean["receipt"]["cleanedAt"], cleaned_at);
    assert_eq!(
        ts_clean["receipt"]["versions"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(
        ts_clean["receipt"]["versions"][0]["textFallback"].as_str(),
        Some(rust_cleaned.text_fallback.text.as_str())
    );

    let cleanup_req = InteractiveCleanupRequest::parse(
        json!({
            "op": "receipt",
            "kind": "result",
            "target": rust_ref,
            "requestId": "req-parity-clean",
            "expectedDigest": expected_digest,
        })
        .to_string()
        .as_bytes(),
    )
    .unwrap();
    let rust_verified_receipt = read_interactive_cleanup_receipt(data_home, &cleanup_req).unwrap();
    assert!(rust_verified_receipt.is_some());
}

#[test]
fn ts_rust_parity_input_attachments_validation_and_limits() {
    let oversized_text = "x".repeat(512 * 1024 + 1);
    let vectors = vec![
        // Valid PNG image upload
        json!({
            "id": "att-1",
            "name": "shot.png",
            "mimeType": "image/png",
            "size": 8,
            "kind": "image",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo="
        }),
        // Valid UTF-8 text upload with whitespace tokens
        json!({
            "id": "  att-txt  ",
            "name": "notes.md",
            "mimeType": "text/markdown",
            "size": 17,
            "kind": "text",
            "text": "部署说明 & status"
        }),
        // Valid unsupported file metadata
        json!({
            "id": "att-bin",
            "name": "archive.bin",
            "mimeType": "application/octet-stream",
            "size": 1024,
            "kind": "unsupported"
        }),
        // Invalid: MIME mismatch between mimeType and dataUrl header
        json!({
            "id": "att-bad-mime",
            "name": "fake.jpg",
            "mimeType": "image/jpeg",
            "size": 8,
            "kind": "image",
            "dataUrl": "data:image/png;base64,iVBORw0KGgo="
        }),
        // Invalid: base64 length not divisible by 4
        json!({
            "id": "att-bad-b64",
            "name": "bad.png",
            "mimeType": "image/png",
            "size": 5,
            "kind": "image",
            "dataUrl": "data:image/png;base64,iVBORw0"
        }),
        // Invalid: text exceeding 512 KiB
        json!({
            "id": "att-too-big",
            "name": "big.txt",
            "mimeType": "text/plain",
            "size": oversized_text.len(),
            "kind": "text",
            "text": oversized_text
        }),
        // Invalid: negative size
        json!({
            "id": "att-neg",
            "name": "neg.txt",
            "mimeType": "text/plain",
            "size": -1,
            "kind": "text",
            "text": "hi"
        }),
        // Invalid: unsupported kind "video"
        json!({
            "id": "att-vid",
            "name": "clip.mp4",
            "mimeType": "video/mp4",
            "size": 100,
            "kind": "video"
        }),
        // Invalid: non-string text payload
        json!({
            "id": "att-nonstr",
            "name": "obj.txt",
            "mimeType": "text/plain",
            "size": 4,
            "kind": "text",
            "text": 1234
        }),
    ];

    // One vector intentionally exceeds the per-environment-string limit on Linux.
    let fixture = tempdir().unwrap();
    let vectors_file = fixture.path().join("vectors.json");
    std::fs::write(&vectors_file, serde_json::to_vec(&vectors).unwrap()).unwrap();
    let ts_results = run_node_json(
        r#"
        import { readFileSync } from 'node:fs';
        import { normalizeUserUpload } from './packages/runtime-node/src/project-agent/input-attachments.mjs';
        const items = JSON.parse(readFileSync(process.env.VECTORS_FILE, 'utf8'));
        const out = items.map(item => {
          try {
            return { ok: true, value: normalizeUserUpload(item) };
          } catch (err) {
            return { ok: false, message: err?.message ?? 'error' };
          }
        });
        console.log(JSON.stringify(out));
        "#,
        &[("VECTORS_FILE", vectors_file.to_str().unwrap())],
    );

    let ts_arr = ts_results.as_array().unwrap();
    assert_eq!(ts_arr.len(), vectors.len());

    for (idx, (vec_item, ts_res)) in vectors.iter().zip(ts_arr.iter()).enumerate() {
        let rust_res = normalize_user_upload(vec_item);
        let ts_ok = ts_res["ok"].as_bool().unwrap();
        assert_eq!(
            ts_ok,
            rust_res.is_ok(),
            "vector {idx} accept/reject mismatch: ts={ts_res:?}, rust={rust_res:?}"
        );
        if let Ok(rust_val) = rust_res {
            assert_eq!(
                rust_val, ts_res["value"],
                "vector {idx} normalized output mismatch"
            );
        }
    }
}

#[test]
fn ts_rust_parity_conversation_search_index_ranking_and_collection() {
    let bots = vec![
        json!({
            "workspaceId": "ws-alpha",
            "profile": { "displayName": "Alpha" },
            "preview": "Primary service bot",
            "lastActiveAt": "2026-11-20T10:00:00.000Z"
        }),
        json!({
            "workspaceId": "ws-beta",
            "profile": { "displayName": "AlphaOps" },
            "preview": "Secondary staging ops",
            "lastActiveAt": "2026-11-20T10:05:00.000Z"
        }),
    ];
    let msg_entries = [
        (
            "ws-alpha",
            json!({
                "id": "m-vis-1",
                "role": "user",
                "kind": "user_input",
                "content": "检查部署日志以及 Alpha 配置",
                "createdAt": "2026-11-20T09:30:00.000Z"
            }),
        ),
        (
            "ws-beta",
            json!({
                "id": "m-vis-2",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Confirmed staging rollout日志一切正常",
                "createdAt": "2026-11-20T09:40:00.000Z"
            }),
        ),
        (
            "ws-alpha",
            json!({
                "id": "m-hidden-turn",
                "role": "assistant",
                "kind": "agent_turn",
                "content": "Internal trace Alpha staging",
                "createdAt": "2026-11-20T09:50:00.000Z"
            }),
        ),
        (
            "ws-alpha",
            json!({
                "id": "m-hidden-comp",
                "role": "system",
                "kind": "compaction",
                "content": "Compaction Alpha",
                "createdAt": "2026-11-20T09:51:00.000Z"
            }),
        ),
    ];
    let tasks = vec![json!({
        "workspaceId": "ws-alpha",
        "sessionId": "sess-1",
        "title": "Audit Alpha deployment pipeline",
        "updatedAt": "2026-11-20T09:55:00.000Z"
    })];
    let memories = vec![
        MemoryItem {
            id: "mem-active-1".into(),
            scope: "project".into(),
            kind: "fact".into(),
            text: "Use staging endpoint before production".into(),
            trust: "stated".into(),
            source_refs: vec!["m-vis-1".into()],
            pinned: false,
            status: "active".into(),
            confirmed_count: 1,
            created_at: "2026-11-20T09:10:00.000Z".into(),
            updated_at: "2026-11-20T09:10:00.000Z".into(),
            last_used_at: None,
            workspace_id: Some("ws-alpha".into()),
            anchor_message_id: None,
            forget_reason: None,
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Map::new(),
        },
        MemoryItem {
            id: "mem-forgotten-1".into(),
            scope: "project".into(),
            kind: "fact".into(),
            text: "Obsolete staging endpoint".into(),
            trust: "stated".into(),
            source_refs: vec!["m-vis-1".into()],
            pinned: false,
            status: "forgotten".into(),
            confirmed_count: 1,
            created_at: "2026-11-20T08:00:00.000Z".into(),
            updated_at: "2026-11-20T08:00:00.000Z".into(),
            last_used_at: None,
            workspace_id: Some("ws-alpha".into()),
            anchor_message_id: None,
            forget_reason: Some("superseded".into()),
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Map::new(),
        },
    ];

    let sync_doc_json = json!({
        "id": "task:ws-beta:sess-sync",
        "kind": "task",
        "workspaceId": "ws-beta",
        "title": "Sync staging probe",
        "text": "Sync staging probe",
        "sessionId": "sess-sync",
        "updatedAt": "2026-11-20T11:00:00.000Z"
    });
    let sync_doc_rust: ConversationSearchDocument =
        serde_json::from_value(sync_doc_json.clone()).unwrap();

    let ts_messages: Vec<Value> = msg_entries
        .iter()
        .map(|(ws, m)| json!({ "workspaceId": ws, "message": m }))
        .collect();
    let fixture_json = serde_json::to_string(&json!({
        "bots": bots,
        "messages": ts_messages,
        "tasks": tasks,
        "memories": memories,
        "syncDoc": sync_doc_json,
    }))
    .unwrap();

    let queries = ["Alpha", "alp", "日志", "部署日志", "staging", ""];
    let queries_json = serde_json::to_string(&queries).unwrap();

    let ts_out = run_node_json(
        r#"
        import {
          collectConversationSearchDocuments,
          createConversationSearchIndex,
        } from './packages/runtime-node/src/project-agent/conversation-search-index.mjs';
        const fix = JSON.parse(process.env.FIXTURE_JSON);
        const queries = JSON.parse(process.env.QUERIES_JSON);
        const docs = collectConversationSearchDocuments({
          bots: fix.bots,
          messages: fix.messages,
          tasks: fix.tasks,
          memories: fix.memories,
        });
        const idx = createConversationSearchIndex();
        idx.rebuild(docs);
        const initialHits = Object.fromEntries(queries.map(q => [q, idx.search(q)]));
        const syncedDocs = docs.filter(d => d.id !== 'memory:mem-active-1').concat([fix.syncDoc]);
        idx.sync(syncedDocs);
        const afterSync = idx.search('staging');
        console.log(JSON.stringify({
          docIds: docs.map(d => d.id),
          initialHits,
          afterSync,
          size: idx.size(),
        }));
        "#,
        &[
            ("FIXTURE_JSON", &fixture_json),
            ("QUERIES_JSON", &queries_json),
        ],
    );

    let msg_refs: Vec<(&str, &Value)> = msg_entries.iter().map(|(ws, m)| (*ws, m)).collect();
    let docs = collect_conversation_search_documents(&bots, &msg_refs, &tasks, &memories);
    let rust_doc_ids: Vec<&str> = docs.iter().map(|d| d.id.as_str()).collect();
    let ts_doc_ids: Vec<&str> = ts_out["docIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(rust_doc_ids, ts_doc_ids);

    let idx = ConversationSearchIndex::open_in_memory().unwrap();
    idx.rebuild(&docs).unwrap();
    for q in queries {
        let rust_hits = idx.search(q, None, None, 50).unwrap();
        let rust_val = serde_json::to_value(&rust_hits).unwrap();
        assert_eq!(
            rust_val, ts_out["initialHits"][q],
            "search ranking/hit parity mismatch for query {q:?}"
        );
    }

    let mut synced_docs: Vec<ConversationSearchDocument> = docs
        .into_iter()
        .filter(|d| d.id != "memory:mem-active-1")
        .collect();
    synced_docs.push(sync_doc_rust);
    idx.sync(&synced_docs).unwrap();
    assert_eq!(
        idx.size().unwrap(),
        ts_out["size"].as_u64().unwrap() as usize
    );
    let after_sync = serde_json::to_value(idx.search("staging", None, None, 50).unwrap()).unwrap();
    assert_eq!(after_sync, ts_out["afterSync"]);
}

fn mem_fixture(
    id: &str,
    scope: &str,
    workspace_id: Option<&str>,
    status: &str,
    trust: &str,
    created_at: &str,
    topic: Option<(&str, &str)>,
) -> MemoryItem {
    let (topic_key, topic_value) = match topic {
        Some((k, v)) => (Some(k.to_owned()), Some(v.to_owned())),
        None => (None, None),
    };
    MemoryItem {
        id: id.into(),
        scope: scope.into(),
        kind: if scope == "user" {
            "preference".into()
        } else {
            "fact".into()
        },
        text: format!("Memory {id}"),
        trust: trust.into(),
        source_refs: vec!["ev-1".into()],
        pinned: false,
        status: status.into(),
        confirmed_count: 1,
        created_at: created_at.into(),
        updated_at: created_at.into(),
        last_used_at: None,
        workspace_id: workspace_id.map(str::to_owned),
        anchor_message_id: None,
        forget_reason: None,
        expires_at: None,
        topic_key,
        topic_value,
        file_anchors: None,
        needs_reverify: None,
        conflict_id: None,
        superseded_by: None,
        maintenance_reason: None,
        conflicts_with: None,
        extra: Map::new(),
    }
}

#[test]
fn ts_rust_parity_memory_conflict_and_watchdog_same_cause() {
    // Part 1: Memory conflict & supersession decision parity
    let existing = vec![
        mem_fixture(
            "m-old-proj",
            "project",
            Some("ws-1"),
            "active",
            "verified",
            "2026-11-20T09:00:00.000Z",
            Some(("pkg_mgr", "npm")),
        ),
        mem_fixture(
            "m-newer-proj",
            "project",
            Some("ws-1"),
            "active",
            "stated",
            "2026-11-20T11:00:00.000Z",
            Some(("pkg_mgr", "bun")),
        ),
        mem_fixture(
            "m-other-ws",
            "project",
            Some("ws-2"),
            "active",
            "stated",
            "2026-11-20T08:00:00.000Z",
            Some(("pkg_mgr", "yarn")),
        ),
        mem_fixture(
            "m-same-val",
            "project",
            Some("ws-1"),
            "active",
            "stated",
            "2026-11-20T08:00:00.000Z",
            Some(("pkg_mgr", "pnpm")),
        ),
        mem_fixture(
            "m-forgotten",
            "project",
            Some("ws-1"),
            "forgotten",
            "stated",
            "2026-11-20T08:00:00.000Z",
            Some(("pkg_mgr", "npm")),
        ),
        mem_fixture(
            "u-old",
            "user",
            None,
            "conflicted",
            "stated",
            "2026-11-20T08:00:00.000Z",
            Some(("editor", "vim")),
        ),
    ];
    let probe_items = vec![
        mem_fixture(
            "new-proj-stated",
            "project",
            Some("ws-1"),
            "active",
            "stated",
            "2026-11-20T10:00:00.000Z",
            Some(("pkg_mgr", "pnpm")),
        ),
        mem_fixture(
            "new-user-inferred",
            "user",
            None,
            "active",
            "inferred",
            "2026-11-20T10:00:00.000Z",
            Some(("editor", "vscode")),
        ),
        mem_fixture(
            "new-no-topic",
            "project",
            Some("ws-1"),
            "active",
            "stated",
            "2026-11-20T10:00:00.000Z",
            None,
        ),
    ];

    // Part 2: Watchdog assess_stall, assess_same_cause & stable_failure_class parity
    let now_ms: i64 = 1_795_100_000_000; // 2026-11-20-ish fixed epoch ms
    let started_under = "2026-11-19T14:50:00.000Z";
    // Use exact relative timestamps from fixed numeric ms so TS & Rust compute identically
    let ts_old_iso = "2026-11-19T00:00:00.000Z";
    let ts_recent_iso = "2026-11-19T00:05:00.000Z";
    let now_stalled_ms: i64 = 1_795_047_600_000; // 2026-11-19T00:20:00.000Z

    let rust_sessions = [
        WatchSessionFacts {
            session_id: "s-run-ok".into(),
            workspace_id: "ws-1".into(),
            plan_id: Some("p-1".into()),
            task_id: Some("t-1".into()),
            version: "v1".into(),
            status: "running".into(),
            completed_at: None,
            result_revision: None,
            started_at: Some(ts_old_iso.into()),
            last_progress_at: Some("2026-11-19T00:15:00.000Z".into()),
            progress_emitted_at: None,
            stall_id: None,
            leaves: vec![],
            needs_user: vec![],
            last_error: String::new(),
            interruption_reason: String::new(),
            interruption_code: String::new(),
            blocked_reason: String::new(),
            recoverable_interruption_count: 0,
            failure_log: vec![],
            verdict_outcome: None,
            verdict_evidence_refs: vec![],
        },
        WatchSessionFacts {
            session_id: "s-run-stalled".into(),
            workspace_id: "ws-1".into(),
            plan_id: Some("p-1".into()),
            task_id: Some("t-1".into()),
            version: "v1".into(),
            status: "running".into(),
            completed_at: None,
            result_revision: None,
            started_at: Some(ts_old_iso.into()),
            last_progress_at: Some(ts_recent_iso.into()),
            progress_emitted_at: None,
            stall_id: None,
            leaves: vec![],
            needs_user: vec![],
            last_error: String::new(),
            interruption_reason: String::new(),
            interruption_code: String::new(),
            blocked_reason: String::new(),
            recoverable_interruption_count: 0,
            failure_log: vec![],
            verdict_outcome: None,
            verdict_evidence_refs: vec![],
        },
        WatchSessionFacts {
            session_id: "s-wait-user".into(),
            workspace_id: "ws-1".into(),
            plan_id: Some("p-1".into()),
            task_id: Some("t-1".into()),
            version: "v1".into(),
            status: "running".into(),
            completed_at: None,
            result_revision: None,
            started_at: Some(ts_old_iso.into()),
            last_progress_at: Some(ts_old_iso.into()),
            progress_emitted_at: None,
            stall_id: None,
            leaves: vec![],
            needs_user: vec![("ap-1".into(), "approval".into())],
            last_error: String::new(),
            interruption_reason: String::new(),
            interruption_code: String::new(),
            blocked_reason: String::new(),
            recoverable_interruption_count: 0,
            failure_log: vec![],
            verdict_outcome: None,
            verdict_evidence_refs: vec![],
        },
        WatchSessionFacts {
            session_id: "s-result-ready".into(),
            workspace_id: "ws-1".into(),
            plan_id: Some("p-1".into()),
            task_id: Some("t-1".into()),
            version: "v1".into(),
            status: "result_ready".into(),
            completed_at: Some(ts_recent_iso.into()),
            result_revision: Some("rev-42".into()),
            started_at: Some(ts_old_iso.into()),
            last_progress_at: None,
            progress_emitted_at: None,
            stall_id: None,
            leaves: vec![],
            needs_user: vec![],
            last_error: String::new(),
            interruption_reason: String::new(),
            interruption_code: String::new(),
            blocked_reason: String::new(),
            recoverable_interruption_count: 0,
            failure_log: vec![],
            verdict_outcome: None,
            verdict_evidence_refs: vec![],
        },
    ];

    let _ = (now_ms, started_under);
    let ts_sessions: Vec<Value> = rust_sessions
        .iter()
        .map(|s| {
            let needs: Vec<Value> = s
                .needs_user
                .iter()
                .map(|(aid, kind)| json!({ "approvalId": aid, "kind": kind }))
                .collect();
            json!({
                "sessionId": s.session_id,
                "workspaceId": s.workspace_id,
                "planId": s.plan_id,
                "taskId": s.task_id,
                "status": s.status,
                "completedAt": s.completed_at,
                "resultRevision": s.result_revision,
                "startedAt": s.started_at,
                "lastProgressAt": s.last_progress_at,
                "needsUser": needs,
            })
        })
        .collect();

    let same_cause_session_rust = WatchSessionFacts {
        session_id: "s-fail-3".into(),
        workspace_id: "ws-1".into(),
        plan_id: Some("p-9".into()),
        task_id: Some("t-9".into()),
        version: "v1".into(),
        status: "interrupted".into(),
        completed_at: None,
        result_revision: None,
        started_at: None,
        last_progress_at: None,
        progress_emitted_at: None,
        stall_id: None,
        leaves: vec![],
        needs_user: vec![],
        last_error: "upstream HTTP 503 service unavailable".into(),
        interruption_reason: "upstream HTTP 503 service unavailable".into(),
        interruption_code: String::new(),
        blocked_reason: String::new(),
        recoverable_interruption_count: 0,
        failure_log: vec![
            json!({ "taskId": "t-9", "cause": "gateway 503 overload" }),
            json!({ "taskId": "t-9", "cause": "http 503 again" }),
            json!({ "taskId": "t-9", "cause": "EACCES permission denied" }),
            json!({ "taskId": "other-task", "cause": "http 503" }),
        ],
        verdict_outcome: None,
        verdict_evidence_refs: vec![],
    };
    let same_cause_session_ts = json!({
        "sessionId": "s-fail-3",
        "workspaceId": "ws-1",
        "planId": "p-9",
        "taskId": "t-9",
        "status": "interrupted",
        "lastError": "upstream HTTP 503 service unavailable",
        "interruption": { "reason": "upstream HTTP 503 service unavailable" },
        "failureLog": same_cause_session_rust.failure_log,
    });

    let failure_samples = vec![
        "request timed out after 30s",
        "连接超时",
        "ECONNRESET socket hang up",
        "EACCES permission denied",
        "HTTP 503 Bad Gateway",
        "model_tool_result_materialization_required",
    ];

    let payload = serde_json::to_string(&json!({
        "existingMemories": existing,
        "probeItems": probe_items,
        "sessions": ts_sessions,
        "nowMs": now_stalled_ms,
        "sameCauseSession": same_cause_session_ts,
        "failureSamples": failure_samples,
    }))
    .unwrap();

    let ts_out = run_node_json(
        r#"
        import { memoryConflictDecision } from './packages/runtime-node/src/memory/conflict.mjs';
        import { assessStall, assessSameCause } from './packages/runtime-node/src/project-agent/watchdog.mjs';
        import { stableFailureClass } from './packages/runtime-node/src/project-agent/progress-policy.mjs';
        const data = JSON.parse(process.env.PAYLOAD_JSON);
        const conflicts = data.probeItems.map(item => memoryConflictDecision(item, data.existingMemories));
        const stalls = data.sessions.map(s => assessStall(s, { now: data.nowMs }));
        const sameCause = assessSameCause(data.sameCauseSession);
        const classes = data.failureSamples.map(v => stableFailureClass(v));
        console.log(JSON.stringify({ conflicts, stalls, sameCause, classes }));
        "#,
        &[("PAYLOAD_JSON", &payload)],
    );

    // Compare memory conflict decisions
    let rust_conflicts: Vec<Value> = probe_items
        .iter()
        .map(|item| serde_json::to_value(memory_conflict_decision(item, &existing)).unwrap())
        .collect();
    assert_eq!(Value::Array(rust_conflicts), ts_out["conflicts"]);

    // Compare assess_stall outcomes
    let rust_stalls: Vec<StallAssessment> = rust_sessions
        .iter()
        .map(|s| assess_stall(s, now_stalled_ms, STALL_WINDOW_MS))
        .collect();
    assert_eq!(
        serde_json::to_value(&rust_stalls).unwrap(),
        ts_out["stalls"]
    );

    // Compare assess_same_cause outcome
    let rust_same_cause: SameCauseAssessment = assess_same_cause(&same_cause_session_rust, None);
    assert_eq!(
        serde_json::to_value(&rust_same_cause).unwrap(),
        ts_out["sameCause"]
    );
    assert!(rust_same_cause.stop_auto_retry);
    assert_eq!(rust_same_cause.count, 3);

    // Compare stable_failure_class across English + Chinese + machine codes
    let rust_classes: Vec<String> = failure_samples
        .iter()
        .map(|s| stable_failure_class(s))
        .collect();
    assert_eq!(
        serde_json::to_value(&rust_classes).unwrap(),
        ts_out["classes"]
    );
}
