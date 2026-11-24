//! Coordination fork inspection, backup, restore, and retention (ADR 99).
//!
//! Matches `coordination-recovery-service.mjs`, `coordination-fork-recovery.mjs`,
//! `history-resumption.mjs`, and `coordination-legacy-integrity.mjs`.

use crate::{NativeProjectHost, ProjectError, is_valid_workspace_id, now_iso, sha256_hex};
use peer_protocol::{
    CoordinationReducer, WORK_HOOK_SEMANTIC_FLOOR, WORK_SHELL_SEMANTIC_FLOOR,
    javascript_json_digest, javascript_json_string, native_processes_in_work,
    native_work_has_hook_facts,
};
use peer_runtime::coordination::{
    HistoryRecoveryFacts, NativeCoordinationReducer, history_checkpoint_bindings,
    plan_history_resumption,
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

const BASE64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BUCKETS: [&str; 17] = [
    "sessionControls",
    "sessionControlHeads",
    "works",
    "events",
    "deliveries",
    "mandates",
    "decisions",
    "transitions",
    "inputBindings",
    "intentDecisions",
    "agentMessages",
    "agentRequests",
    "agentCommands",
    "workNotes",
    "contextWindows",
    "obligationGrants",
    "obligationHeads",
];

fn encode_base64(input: &[u8]) -> String {
    if input.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_TABLE[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn is_checkpoint_ref(s: &str) -> bool {
    s.strip_suffix(".json").is_some_and(is_hex64)
}

fn is_valid_token_or_id(s: &str, max_len: usize) -> bool {
    !s.is_empty() && s.len() <= max_len && !s.contains(['\r', '\n'])
}

fn blank_state() -> Value {
    json!({
        "revision": 0,
        "events": {},
        "works": {},
        "deliveries": {},
    })
}

fn workspace_runtime_dir(data_home: &Path, workspace_id: &str) -> Result<PathBuf, ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("invalid_workspace"));
    }
    let runtime_root = fs::canonicalize(data_home.join("project-runtime"))
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    let candidate = runtime_root.join(workspace_id);
    let meta = fs::symlink_metadata(&candidate)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(ProjectError::code("coordination_repair_path_invalid"));
    }
    let real = fs::canonicalize(&candidate)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    if real != candidate {
        return Err(ProjectError::code("coordination_repair_path_invalid"));
    }
    Ok(real)
}

fn contained_tree(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
    let mut cur = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(ProjectError::code("coordination_repair_path_invalid"));
        }
        cur = cur.join(part);
        if let Ok(meta) = fs::symlink_metadata(&cur)
            && meta.file_type().is_symlink()
        {
            return Err(ProjectError::code("coordination_repair_path_invalid"));
        }
    }
    Ok(cur)
}

fn ensure_regular(file: &Path) -> Result<(), ProjectError> {
    let meta = fs::symlink_metadata(file)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(ProjectError::code("coordination_repair_path_invalid"));
    }
    Ok(())
}

fn read_json_regular(file: &Path) -> Result<Value, ProjectError> {
    ensure_regular(file)?;
    let raw =
        fs::read_to_string(file).map_err(|_| ProjectError::code("coordination_read_failed"))?;
    serde_json::from_str(&raw).map_err(|_| ProjectError::code("coordination_journal_invalid"))
}

fn sync_directory(dir: &Path) -> Result<(), ProjectError> {
    if let Ok(f) = File::open(dir) {
        f.sync_all()
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    Ok(())
}

fn write_durable_json(file: &Path, value: &Value) -> Result<(), ProjectError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
    write_durable_bytes(file, &bytes)
}

fn write_durable_bytes(file: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let parent = file
        .parent()
        .ok_or_else(|| ProjectError::code("coordination_repair_path_invalid"))?;
    fs::create_dir_all(parent).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    let mut tmp =
        NamedTempFile::new_in(parent).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    tmp.persist(file)
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    sync_directory(parent)?;
    Ok(())
}

fn stat_token(meta: &fs::Metadata) -> String {
    peer_store::file_stat_token(meta)
}

fn hash_file(file: &Path, end: Option<usize>, seed: Option<&[u8]>) -> Result<Value, ProjectError> {
    ensure_regular(file)?;
    let before =
        fs::symlink_metadata(file).map_err(|_| ProjectError::code("coordination_read_failed"))?;
    let bytes = fs::read(file).map_err(|_| ProjectError::code("coordination_read_failed"))?;
    let after =
        fs::symlink_metadata(file).map_err(|_| ProjectError::code("coordination_read_changed"))?;
    if stat_token(&before) != stat_token(&after) {
        return Err(ProjectError::code("coordination_read_changed"));
    }
    let slice_len = end.unwrap_or(bytes.len());
    if slice_len > bytes.len() {
        return Err(ProjectError::code("coordination_repair_prefix_invalid"));
    }
    let mut hasher = Sha256::new();
    if let Some(prefix) = seed {
        hasher.update(prefix);
    }
    hasher.update(&bytes[..slice_len]);
    let digest = format!("{:x}", hasher.finalize());
    Ok(json!({
        "bytes": slice_len as u64,
        "sha256": digest,
    }))
}

fn walk_dir_relative(
    root: &Path,
    relative: &str,
    out: &mut Vec<String>,
) -> Result<(), ProjectError> {
    let dir = contained_tree(root, relative)?;
    let meta = fs::symlink_metadata(&dir)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(ProjectError::code("coordination_repair_path_invalid"));
    }
    let mut names: Vec<String> = fs::read_dir(&dir)
        .map_err(|_| ProjectError::code("coordination_read_failed"))?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        let rel = format!("{relative}/{name}");
        let p = contained_tree(root, &rel)?;
        let info = fs::symlink_metadata(&p)
            .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
        if info.file_type().is_symlink() {
            return Err(ProjectError::code("coordination_repair_path_invalid"));
        }
        if info.is_dir() {
            walk_dir_relative(root, &rel, out)?;
        } else if info.is_file() {
            out.push(rel);
        } else {
            return Err(ProjectError::code("coordination_repair_path_invalid"));
        }
    }
    Ok(())
}

fn inventory(directory: &Path, additional: &[String]) -> Result<Map<String, Value>, ProjectError> {
    let mut files = vec!["coordination.jsonl".to_owned()];
    files.extend(additional.iter().cloned());
    walk_dir_relative(directory, "coordination-v2", &mut files)?;
    files.sort();
    files.dedup();
    let mut out = Map::new();
    for file in files {
        let target = contained_tree(directory, &file)?;
        if !target.exists() {
            out.insert(file, json!({ "missing": true }));
        } else {
            out.insert(file, hash_file(&target, None, None)?);
        }
    }
    Ok(out)
}

fn read_legacy_seal(directory: &Path, manifest: &Value) -> Result<Option<Value>, ProjectError> {
    let file = directory.join("coordination-v2").join("legacy-seal.json");
    if !file.exists() {
        return Ok(None);
    }
    ensure_regular(&file)?;
    let meta =
        fs::metadata(&file).map_err(|_| ProjectError::code("coordination_legacy_seal_invalid"))?;
    if meta.len() > 4096 {
        return Err(ProjectError::code("coordination_legacy_seal_invalid"));
    }
    let seal = read_json_regular(&file)
        .map_err(|_| ProjectError::code("coordination_legacy_seal_invalid"))?;
    let digest = seal["sha256"].as_str().unwrap_or("");
    if seal["schemaVersion"].as_u64() != Some(1)
        || seal["generation"] != manifest["generation"]
        || seal["legacyVersion"] != manifest["legacyVersion"]
        || seal["bytes"].as_u64().is_none()
        || !is_hex64(digest)
    {
        return Err(ProjectError::code("coordination_legacy_seal_invalid"));
    }
    Ok(Some(seal))
}

struct ReplayResult {
    state: Value,
    hash: String,
    observed_head: bool,
}

#[allow(clippy::too_many_arguments)]
fn replay_file(
    file: &Path,
    mut state: Value,
    start: usize,
    end: Option<usize>,
    v2: bool,
    mut hash: String,
    blobs_dir: Option<&Path>,
    allow_partial_tail: bool,
    target_head: Option<(u64, &str)>,
) -> Result<ReplayResult, ProjectError> {
    ensure_regular(file)?;
    let raw_bytes = fs::read(file).map_err(|_| ProjectError::code("coordination_read_failed"))?;
    let slice_end = end.unwrap_or(raw_bytes.len());
    if start > slice_end || slice_end > raw_bytes.len() {
        return Err(ProjectError::code("coordination_repair_prefix_invalid"));
    }
    let text = String::from_utf8(raw_bytes[start..slice_end].to_vec())
        .map_err(|_| ProjectError::code("coordination_journal_invalid"))?;
    let mut observed_head =
        target_head.is_some_and(|(rev, h)| state["revision"].as_u64() == Some(rev) && hash == h);

    let mut lines = text.split_inclusive('\n').peekable();
    while let Some(chunk) = lines.next() {
        let terminated = chunk.ends_with('\n');
        let line = chunk.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            continue;
        }
        if !terminated && !allow_partial_tail {
            return Err(ProjectError::code("coordination_repair_partial_tail"));
        }
        let mut entry: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) if !terminated && allow_partial_tail && lines.peek().is_none() => break,
            Err(_) => return Err(ProjectError::code("coordination_journal_invalid")),
        };
        if v2 {
            let obj = entry
                .as_object_mut()
                .ok_or_else(|| ProjectError::code("coordination_journal_invalid"))?;
            let actual = obj
                .shift_remove("hash")
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or_else(|| ProjectError::code("coordination_hash_mismatch"))?;
            let prev = obj
                .get("previousHash")
                .and_then(Value::as_str)
                .unwrap_or("");
            if obj.get("storageVersion").and_then(Value::as_u64) != Some(2) || prev != hash {
                return Err(ProjectError::code("coordination_hash_mismatch"));
            }
            let expected = javascript_json_digest(&entry)
                .map_err(|_| ProjectError::code("coordination_hash_mismatch"))?;
            if expected != actual {
                return Err(ProjectError::code("coordination_hash_mismatch"));
            }
            hash = actual;
            if entry["kind"].as_str() == Some("payload_ref") {
                let bdir =
                    blobs_dir.ok_or_else(|| ProjectError::code("coordination_payload_invalid"))?;
                let payload_hash = entry["payloadRef"]["hash"].as_str().unwrap_or("");
                let payload_bytes = entry["payloadRef"]["bytes"].as_u64();
                if !is_hex64(payload_hash) {
                    return Err(ProjectError::code("coordination_payload_invalid"));
                }
                let blob_path = bdir.join(format!("{payload_hash}.json"));
                ensure_regular(&blob_path)?;
                let blob = fs::read(&blob_path)
                    .map_err(|_| ProjectError::code("coordination_payload_invalid"))?;
                if payload_bytes != Some(blob.len() as u64) || sha256_hex(&blob) != payload_hash {
                    return Err(ProjectError::code("coordination_payload_invalid"));
                }
                let mut expanded: Value = serde_json::from_slice(&blob)
                    .map_err(|_| ProjectError::code("coordination_payload_invalid"))?;
                expanded["schemaVersion"] = json!(1);
                expanded["revision"] = entry["revision"].clone();
                entry = expanded;
            }
        }
        state = NativeCoordinationReducer
            .reduce(&state, &entry)
            .map_err(ProjectError::code)?;
        if let Some((rev, h)) = target_head
            && state["revision"].as_u64() == Some(rev)
            && hash == h
        {
            observed_head = true;
        }
    }

    Ok(ReplayResult {
        state,
        hash,
        observed_head,
    })
}

fn sort_value_keys(v: &Value) -> Value {
    match v {
        Value::Object(fields) => {
            let mut entries: Vec<_> = fields.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let mut m = Map::new();
            for (k, val) in entries {
                m.insert(k.clone(), sort_value_keys(val));
            }
            Value::Object(m)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_value_keys).collect()),
        _ => v.clone(),
    }
}

fn sorted_json_digest(v: &Value) -> String {
    javascript_json_digest(&sort_value_keys(v))
        .unwrap_or_else(|_| sha256_hex(v.to_string().as_bytes()))
}

fn stable_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        _ => sorted_json_digest(a) == sorted_json_digest(b),
    }
}

fn list_v2_segments(directory: &Path) -> Result<Vec<String>, ProjectError> {
    let seg_dir = contained_tree(directory, "coordination-v2/segments")?;
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(&seg_dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.len() == 18
                && name.ends_with(".jsonl")
                && name[..12].bytes().all(|b| b.is_ascii_digit())
            {
                out.push(format!("coordination-v2/segments/{name}"));
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Offline inspection of a coordination fork (`coordination.jsonl` appended past v2 baseline).
pub fn inspect_coordination_fork(directory: &Path) -> Result<Value, ProjectError> {
    let dir = fs::canonicalize(directory)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    let mut sources = inventory(&dir, &[])?;
    let v2 = contained_tree(&dir, "coordination-v2")?;
    let manifest = read_json_regular(&v2.join("manifest.json"))?;
    let head = read_json_regular(&v2.join("head.json"))?;
    if manifest["schemaVersion"].as_u64() != Some(2)
        || manifest["minimumReaderVersion"].as_u64() != Some(2)
        || manifest["minimumWriterVersion"].as_u64() != Some(2)
        || manifest["legacyFile"].as_str() != Some("coordination.jsonl")
        || manifest["generation"] != head["generation"]
        || manifest["legacyVersion"] != head["legacyVersion"]
    {
        return Err(ProjectError::code("coordination_repair_baseline_invalid"));
    }
    let legacy_ver = manifest["legacyVersion"].as_str().unwrap_or("");
    let prefix_bytes = legacy_ver
        .split(':')
        .nth(2)
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or_else(|| ProjectError::code("coordination_repair_no_fork"))?;
    let legacy_total = sources
        .get("coordination.jsonl")
        .and_then(|v| v["bytes"].as_u64())
        .unwrap_or(0) as usize;
    if prefix_bytes == 0 || prefix_bytes >= legacy_total {
        return Err(ProjectError::code("coordination_repair_no_fork"));
    }
    let legacy_file = dir.join("coordination.jsonl");
    let prefix = hash_file(&legacy_file, Some(prefix_bytes), None)?;
    let seal = read_legacy_seal(&dir, &manifest)?;
    if let Some(ref s) = seal
        && (s["bytes"] != prefix["bytes"] || s["sha256"] != prefix["sha256"])
    {
        return Err(ProjectError::code("coordination_legacy_changed"));
    }

    let base_res = replay_file(
        &legacy_file,
        blank_state(),
        0,
        Some(prefix_bytes),
        false,
        String::new(),
        None,
        false,
        None,
    )?;
    let base = base_res.state;
    let blobs_dir = v2.join("blobs");
    let mut segs: Vec<String> = sources
        .keys()
        .filter(|k| k.starts_with("coordination-v2/segments/") && k.ends_with(".jsonl"))
        .cloned()
        .collect();
    segs.sort();
    let mut cur_state = base.clone();
    let mut cur_hash = String::new();
    for seg in &segs {
        let rep = replay_file(
            &dir.join(seg),
            cur_state,
            0,
            None,
            true,
            cur_hash,
            Some(&blobs_dir),
            false,
            None,
        )?;
        cur_state = rep.state;
        cur_hash = rep.hash;
    }
    if cur_state["revision"] != head["revision"] || cur_hash != head["hash"].as_str().unwrap_or("")
    {
        return Err(ProjectError::code("coordination_journal_missing"));
    }
    let old_res = replay_file(
        &legacy_file,
        base.clone(),
        prefix_bytes,
        None,
        false,
        String::new(),
        None,
        false,
        None,
    )?;
    let old_state = old_res.state;

    let mut checkpoints = Vec::new();
    let mut refs = HashSet::new();
    for (branch, st) in [
        ("baseline", &base),
        ("current", &cur_state),
        ("legacy", &old_state),
    ] {
        if let Some(works) = st["works"].as_object() {
            for work in works.values() {
                let wid = work["workId"].as_str().unwrap_or("");
                let bindings = history_checkpoint_bindings(work).map_err(ProjectError::code)?;
                for b in bindings {
                    let rf = b["ref"].as_str().unwrap_or("");
                    let owner = b["owner"].as_str().unwrap_or("");
                    if !is_checkpoint_ref(rf) {
                        checkpoints.push(json!({
                            "branch": branch,
                            "workId": wid,
                            "ref": rf,
                            "status": "invalid_ref",
                        }));
                        continue;
                    }
                    let rel = format!("checkpoints/{rf}");
                    let cp_file = contained_tree(&dir, &rel)?;
                    refs.insert(rel);
                    if !cp_file.exists() {
                        checkpoints.push(json!({
                            "branch": branch,
                            "workId": wid,
                            "ref": rf,
                            "status": "missing",
                        }));
                        continue;
                    }
                    let proof = hash_file(&cp_file, None, None)?;
                    let seed = format!("{owner}\n");
                    let bound = hash_file(&cp_file, None, Some(seed.as_bytes()))?;
                    let ok_ref = format!("{}.json", bound["sha256"].as_str().unwrap_or("")) == rf;
                    checkpoints.push(json!({
                        "branch": branch,
                        "workId": wid,
                        "ref": rf,
                        "status": if ok_ref { "verified" } else { "hash_mismatch" },
                        "bytes": proof["bytes"],
                        "sha256": proof["sha256"],
                    }));
                }
            }
        }
    }

    let extra_refs: Vec<String> = refs.into_iter().collect();
    let bound_sources = inventory(&dir, &extra_refs)?;
    for (k, v) in &sources {
        if !bound_sources.get(k).is_some_and(|bv| stable_eq(v, bv)) {
            return Err(ProjectError::code("coordination_read_changed"));
        }
    }
    sources = bound_sources;

    let mut conflicts = Vec::new();
    let mut merged = blank_state();
    for bucket in BUCKETS {
        let a = base[bucket].as_object();
        let b = cur_state[bucket].as_object();
        let c = old_state[bucket].as_object();
        let mut ids = HashSet::new();
        for map in [a, b, c].into_iter().flatten() {
            for k in map.keys() {
                ids.insert(k.clone());
            }
        }
        let mut id_list: Vec<String> = ids.into_iter().collect();
        id_list.sort();
        let mut bucket_map = Map::new();
        for id in id_list {
            let va = a.and_then(|m| m.get(&id));
            let vb = b.and_then(|m| m.get(&id));
            let vc = c.and_then(|m| m.get(&id));
            let same_opt = |x: Option<&Value>, y: Option<&Value>| match (x, y) {
                (None, None) => true,
                (Some(xv), Some(yv)) => stable_eq(xv, yv),
                _ => false,
            };
            let is_conflict = !same_opt(vb, vc) && !same_opt(va, vb) && !same_opt(va, vc);
            let chosen = if same_opt(va, vb) { vc } else { vb };
            if let Some(val) = chosen {
                bucket_map.insert(id.clone(), val.clone());
            }
            if is_conflict {
                conflicts.push(json!({
                    "bucket": bucket,
                    "id": id,
                    "baseline": va.cloned().unwrap_or(Value::Null),
                    "current": vb.cloned().unwrap_or(Value::Null),
                    "legacy": vc.cloned().unwrap_or(Value::Null),
                }));
            }
        }
        merged[bucket] = Value::Object(bucket_map);
    }

    let mut held_work_ids = Vec::new();
    if let Some(works) = merged["works"].as_object_mut() {
        for work in works.values_mut() {
            let state_str = work["state"].as_str().unwrap_or("");
            if matches!(state_str, "cancelled" | "delivered" | "coalesced") {
                continue;
            }
            if let Some(wid) = work["workId"].as_str() {
                held_work_ids.push(wid.to_owned());
            }
            let prev_recovery = work.get("recovery").cloned().unwrap_or(Value::Null);
            work["historyRecovery"] = json!({
                "disposition": "held",
                "previousState": state_str,
                "previousRecovery": prev_recovery,
            });
            let mut rec = work
                .get("recovery")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            rec.insert("retryable".to_owned(), json!(false));
            rec.remove("retryAt");
            rec.remove("reservationId");
            rec.insert(
                "blockedCode".to_owned(),
                json!("COORDINATION_RECONCILIATION_REQUIRED"),
            );
            work["recovery"] = Value::Object(rec);
        }
    }
    held_work_ids.sort();
    merged["revision"] = json!(0);

    let sources_val = Value::Object(sources.clone());
    let source_fp = sorted_json_digest(&sources_val);
    let result = json!({
        "schemaVersion": 1,
        "sourceFingerprint": source_fp,
        "sources": sources_val,
        "baselinePrefix": prefix,
        "unsealedBaseline": seal.is_none(),
        "generation": manifest["generation"],
        "baseRevision": base["revision"],
        "currentRevision": cur_state["revision"],
        "legacyRevision": old_state["revision"],
        "conflicts": conflicts,
        "checkpoints": checkpoints,
        "heldWorkIds": held_work_ids,
        "executionBlocked": true,
        "state": merged,
    });
    let recheck = Value::Object(inventory(&dir, &extra_refs)?);
    if !stable_eq(&sources_val, &recheck) {
        return Err(ProjectError::code("coordination_read_changed"));
    }
    Ok(result)
}

fn read_recovered_coordination(
    directory: &Path,
    generation: &str,
) -> Result<(Value, String), ProjectError> {
    let dir = fs::canonicalize(directory)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    let manifest_file = contained_tree(&dir, "coordination-v2/manifest.json")?;
    let head_file = contained_tree(&dir, "coordination-v2/head.json")?;
    let segs = list_v2_segments(&dir)?;
    let mut files = vec![
        "coordination-v2/manifest.json".to_owned(),
        "coordination-v2/head.json".to_owned(),
        "coordination-v2/baseline.jsonl".to_owned(),
    ];
    files.extend(segs.iter().cloned());
    let mut before_proof = Map::new();
    for f in &files {
        before_proof.insert(f.clone(), hash_file(&contained_tree(&dir, f)?, None, None)?);
    }
    let manifest = read_json_regular(&manifest_file)?;
    let head = read_json_regular(&head_file)?;
    let fence_meta = fs::symlink_metadata(contained_tree(&dir, "coordination.jsonl")?)
        .map_err(|_| ProjectError::code("coordination_repair_plan_changed"))?;
    let reader_ver = manifest["minimumReaderVersion"].as_u64().unwrap_or(0);
    if manifest["schemaVersion"].as_u64() != Some(2)
        || !(3..=WORK_SHELL_SEMANTIC_FLOOR).contains(&reader_ver)
        || manifest["minimumWriterVersion"].as_u64() != Some(reader_ver)
        || manifest["frozenLegacyFile"].as_str() != Some("baseline.jsonl")
        || manifest["generation"].as_str() != Some(generation)
        || head["generation"].as_str() != Some(generation)
        || manifest["legacyVersion"] != head["legacyVersion"]
        || !fence_meta.is_dir()
    {
        return Err(ProjectError::code("coordination_repair_plan_changed"));
    }
    let head_rev = head["revision"].as_u64().unwrap_or(0);
    let head_hash = head["hash"].as_str().unwrap_or("");
    let baseline = contained_tree(&dir, "coordination-v2/baseline.jsonl")?;
    let mut rep = replay_file(
        &baseline,
        blank_state(),
        0,
        None,
        false,
        String::new(),
        None,
        false,
        Some((head_rev, head_hash)),
    )?;
    let blobs_dir = contained_tree(&dir, "coordination-v2/blobs")?;
    let seg_count = segs.len();
    for (idx, seg) in segs.iter().enumerate() {
        let next = replay_file(
            &contained_tree(&dir, seg)?,
            rep.state,
            0,
            None,
            true,
            rep.hash,
            Some(&blobs_dir),
            idx + 1 == seg_count,
            Some((head_rev, head_hash)),
        )?;
        rep.state = next.state;
        rep.hash = next.hash;
        rep.observed_head = rep.observed_head || next.observed_head;
    }
    if !rep.observed_head || rep.state["revision"].as_u64().unwrap_or(0) < head_rev {
        return Err(ProjectError::code("coordination_journal_missing"));
    }
    let mut after_proof = Map::new();
    for f in &files {
        after_proof.insert(f.clone(), hash_file(&contained_tree(&dir, f)?, None, None)?);
    }
    if list_v2_segments(&dir)? != segs
        || !stable_eq(
            &Value::Object(before_proof.clone()),
            &Value::Object(after_proof),
        )
    {
        return Err(ProjectError::code("coordination_read_changed"));
    }
    Ok((rep.state, sorted_json_digest(&Value::Object(before_proof))))
}

struct DirCheckpointFacts<'a> {
    dir: &'a Path,
    state: &'a Value,
    safe_sessions: HashSet<String>,
}

impl HistoryRecoveryFacts for DirCheckpointFacts<'_> {
    fn checkpoint(
        &self,
        work_id: &str,
        reference: Option<&str>,
    ) -> Result<Option<Value>, &'static str> {
        let Some(ref_str) = reference.filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        if !is_checkpoint_ref(ref_str) {
            return Err("invalid_checkpoint");
        }
        let cp_dir = self.dir.join("checkpoints");
        let dir_meta =
            fs::symlink_metadata(&cp_dir).map_err(|_| "coordination_repair_path_invalid")?;
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            return Err("coordination_repair_path_invalid");
        }
        let cp_file = cp_dir.join(ref_str);
        let file_meta =
            fs::symlink_metadata(&cp_file).map_err(|_| "coordination_repair_path_invalid")?;
        if file_meta.file_type().is_symlink() || !file_meta.is_file() {
            return Err("coordination_repair_path_invalid");
        }
        let bytes = fs::read(&cp_file).map_err(|_| "coordination_read_failed")?;
        let work = &self.state["works"][work_id];
        let bindings = history_checkpoint_bindings(work)?;
        let owner_match = bindings.iter().any(|row| {
            row["ref"].as_str() == Some(ref_str)
                && row["owner"].as_str().is_some_and(|owner| {
                    let mut buf = Vec::with_capacity(owner.len() + 1 + bytes.len());
                    buf.extend_from_slice(owner.as_bytes());
                    buf.push(b'\n');
                    buf.extend_from_slice(&bytes);
                    format!("{}.json", sha256_hex(&buf)) == ref_str
                })
        });
        if !owner_match {
            return Err("coordination_checkpoint_changed");
        }
        let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_checkpoint")?;
        Ok(Some(parsed))
    }

    fn session_safe(&self, session_id: &str) -> bool {
        self.safe_sessions.contains(session_id)
    }
}

fn read_saved_inspection(dir: &Path) -> Result<(Value, Value), ProjectError> {
    let intent = read_json_regular(&dir.join("coordination-recovery.json"))?;
    let fp = intent["sourceFingerprint"].as_str().unwrap_or("");
    let archive = intent["archive"].as_str().unwrap_or("");
    if intent["schemaVersion"].as_u64() != Some(1)
        || !is_hex64(fp)
        || archive != format!(".coordination-recovery/{fp}")
    {
        return Err(ProjectError::code("coordination_repair_plan_changed"));
    }
    let _ = contained_tree(dir, ".coordination-recovery")?;
    let archive_dir = contained_tree(dir, archive)?;
    let inspection = read_json_regular(&archive_dir.join("inspection.json"))?;
    if inspection["sourceFingerprint"].as_str() != Some(fp)
        || sorted_json_digest(&inspection["sources"]) != fp
    {
        return Err(ProjectError::code("coordination_repair_plan_changed"));
    }
    Ok((intent, inspection))
}

fn history_work_held(work: &Value) -> bool {
    work["historyRecovery"]["disposition"].as_str() == Some("held")
}

fn history_terminal(work: &Value) -> bool {
    matches!(
        work["state"].as_str(),
        Some("delivered" | "cancelled" | "coalesced")
    )
}

fn recover_fork_backup(
    dir: &Path,
    source_fingerprint: &str,
    reviewed_prefix_sha256: &str,
) -> Result<Value, ProjectError> {
    let dir = fs::canonicalize(dir)
        .map_err(|_| ProjectError::code("coordination_repair_path_invalid"))?;
    let intent_file = dir.join("coordination-recovery.json");
    let intent = if intent_file.exists() {
        let loaded = read_json_regular(&intent_file)?;
        if loaded["schemaVersion"].as_u64() != Some(1)
            || loaded["sourceFingerprint"].as_str() != Some(source_fingerprint)
            || loaded["reviewedPrefixSha256"].as_str() != Some(reviewed_prefix_sha256)
            || !is_hex64(source_fingerprint)
            || loaded["archive"].as_str()
                != Some(format!(".coordination-recovery/{source_fingerprint}").as_str())
        {
            return Err(ProjectError::code("coordination_repair_plan_changed"));
        }
        loaded
    } else {
        let plan = inspect_coordination_fork(&dir)?;
        if plan["sourceFingerprint"].as_str() != Some(source_fingerprint)
            || plan["baselinePrefix"]["sha256"].as_str() != Some(reviewed_prefix_sha256)
        {
            return Err(ProjectError::code("coordination_repair_plan_changed"));
        }
        let archive_rel = format!(".coordination-recovery/{source_fingerprint}");
        let root = contained_tree(&dir, &archive_rel)?;
        fs::create_dir_all(&root).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        if let Some(sources) = plan["sources"].as_object() {
            for (rel, proof) in sources {
                if proof["missing"] == true {
                    continue;
                }
                let dest = contained_tree(&dir, &format!("{archive_rel}/original/{rel}"))?;
                if !dest.exists() {
                    let bytes = fs::read(dir.join(rel))
                        .map_err(|_| ProjectError::code("coordination_read_failed"))?;
                    write_durable_bytes(&dest, &bytes)?;
                }
                if !stable_eq(&hash_file(&dest, None, None)?, proof) {
                    return Err(ProjectError::code("coordination_read_changed"));
                }
            }
        }
        let generation = uuid::Uuid::new_v4().to_string();
        let candidate_name = format!("candidate-{generation}");
        let candidate = root.join(&candidate_name);
        fs::create_dir_all(candidate.join("segments"))
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let conflicts_compact: Vec<Value> = plan["conflicts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| json!({ "bucket": c["bucket"], "id": c["id"] }))
            .collect();
        let recovery_meta = json!({
            "sourceFingerprint": source_fingerprint,
            "archive": archive_rel,
            "executionBlocked": true,
            "heldWorkIds": plan["heldWorkIds"],
            "conflicts": conflicts_compact,
        });
        let entry = json!({
            "kind": "history_reconciled",
            "schemaVersion": 1,
            "revision": 1,
            "state": plan["state"],
            "recovery": recovery_meta,
            "stateHash": sorted_json_digest(&plan["state"]),
            "at": now_iso(),
        });
        let entry_line = format!(
            "{}\n",
            javascript_json_string(&entry)
                .map_err(|e| ProjectError::new("SERIALIZE_ERROR", format!("{e:?}")))?
        );
        let baseline_path = candidate.join("baseline.jsonl");
        write_durable_bytes(&baseline_path, entry_line.as_bytes())?;
        let bmeta = fs::symlink_metadata(&baseline_path)
            .map_err(|_| ProjectError::code("coordination_read_failed"))?;
        let legacy_version = stat_token(&bmeta);

        let st = &plan["state"];
        let works = st["works"].as_object();
        let has_hooks = works.is_some_and(|m| {
            m.values()
                .any(|w| native_work_has_hook_facts(w).is_ok_and(|b| b))
        });
        let has_procs = works.is_some_and(|m| {
            m.values()
                .any(|w| native_processes_in_work(w).is_ok_and(|p| !p.is_empty()))
        });
        let has_ctrl = ["sessionControls", "sessionControlHeads"]
            .into_iter()
            .any(|b| st[b].as_object().is_some_and(|m| !m.is_empty()))
            || st["intentDecisions"]
                .as_object()
                .is_some_and(|m| !m.is_empty())
            || works.is_some_and(|m| {
                m.values()
                    .any(|w| w.get("intentCoordination").is_some_and(|v| !v.is_null()))
            });
        let has_closure = st["transitions"].as_object().is_some_and(|m| {
            m.values().any(|r| {
                r["minimumExecutorVersion"].as_u64() == Some(3)
                    || r.get("reconciliationRef").is_some()
            })
        }) || st["agentCommands"]
            .as_object()
            .is_some_and(|m| m.values().any(|r| r["completionRecorded"] == true));
        let has_supervision = [
            "agentMessages",
            "agentRequests",
            "agentCommands",
            "workNotes",
            "contextWindows",
        ]
        .into_iter()
        .any(|b| st[b].as_object().is_some_and(|m| !m.is_empty()));
        let semantic_floor = if has_hooks {
            WORK_HOOK_SEMANTIC_FLOOR
        } else if has_procs {
            13
        } else if has_ctrl {
            9
        } else if has_closure {
            6
        } else if has_supervision {
            5
        } else {
            3
        };
        let manifest_floor =
            read_json_regular(&dir.join("coordination-v2/manifest.json"))?["minimumWriterVersion"]
                .as_u64()
                .unwrap_or(2);
        let head_floor =
            read_json_regular(&dir.join("coordination-v2/head.json"))?["minimumWriterVersion"]
                .as_u64()
                .unwrap_or(2);
        let min_ver = semantic_floor.max(manifest_floor).max(head_floor);
        write_durable_json(
            &candidate.join("head.json"),
            &json!({
                "generation": generation,
                "legacyVersion": legacy_version,
                "revision": 1,
                "hash": "",
                "minimumWriterVersion": min_ver,
            }),
        )?;
        write_durable_json(
            &candidate.join("manifest.json"),
            &json!({
                "schemaVersion": 2,
                "minimumReaderVersion": min_ver,
                "minimumWriterVersion": min_ver,
                "generation": generation,
                "legacyFile": "coordination.jsonl",
                "frozenLegacyFile": "baseline.jsonl",
                "legacyVersion": legacy_version,
            }),
        )?;
        write_durable_json(&root.join("inspection.json"), &plan)?;
        let mut candidate_proof = Map::new();
        for name in ["baseline.jsonl", "head.json", "manifest.json"] {
            candidate_proof.insert(
                name.to_owned(),
                hash_file(&candidate.join(name), None, None)?,
            );
        }
        let prepared = json!({
            "schemaVersion": 1,
            "sourceFingerprint": source_fingerprint,
            "reviewedPrefixSha256": reviewed_prefix_sha256,
            "archive": archive_rel,
            "generation": generation,
            "candidateName": candidate_name,
            "candidateProof": candidate_proof,
            "status": "prepared",
        });
        write_durable_json(&intent_file, &prepared)?;
        prepared
    };

    let archive = intent["archive"]
        .as_str()
        .ok_or_else(|| ProjectError::code("coordination_repair_plan_changed"))?;
    let generation = intent["generation"]
        .as_str()
        .ok_or_else(|| ProjectError::code("coordination_repair_plan_changed"))?;
    let candidate_name = intent["candidateName"]
        .as_str()
        .filter(|s| s.starts_with("candidate-") && s.len() == 46)
        .ok_or_else(|| ProjectError::code("coordination_repair_plan_changed"))?;
    let root = contained_tree(&dir, archive)?;
    let plan = read_json_regular(&root.join("inspection.json"))?;
    if plan["sourceFingerprint"].as_str() != Some(source_fingerprint)
        || sorted_json_digest(&plan["sources"]) != source_fingerprint
        || plan["baselinePrefix"]["sha256"].as_str() != Some(reviewed_prefix_sha256)
    {
        return Err(ProjectError::code("coordination_repair_plan_changed"));
    }
    let canonical = dir.join("coordination-v2");
    let legacy = dir.join("coordination.jsonl");
    if intent["status"].as_str() == Some("complete") {
        let m = read_json_regular(&canonical.join("manifest.json"))?;
        let fence_ok = fs::symlink_metadata(&legacy).is_ok_and(|meta| meta.is_dir());
        if m["generation"].as_str() != Some(generation) || !fence_ok {
            return Err(ProjectError::code("coordination_repair_plan_changed"));
        }
        return Ok(json!({
            "ok": true,
            "executionBlocked": true,
            "archive": archive,
            "reused": true,
        }));
    }

    let validate_candidate = |cdir: &Path| -> Result<(), ProjectError> {
        let Some(cp) = intent["candidateProof"].as_object() else {
            return Err(ProjectError::code("coordination_repair_plan_changed"));
        };
        if cp.len() != 3 {
            return Err(ProjectError::code("coordination_repair_plan_changed"));
        }
        for (k, proof) in cp {
            if !["baseline.jsonl", "head.json", "manifest.json"].contains(&k.as_str())
                || !stable_eq(&hash_file(&cdir.join(k), None, None)?, proof)
            {
                return Err(ProjectError::code("coordination_read_changed"));
            }
        }
        Ok(())
    };

    let staged = contained_tree(&dir, &format!("{archive}/{candidate_name}"))?;
    validate_candidate(if staged.exists() { &staged } else { &canonical })?;
    let moved_v2 = root.join("moved-v2");
    let moved_legacy = root.join("moved-legacy.jsonl");
    if !moved_v2.exists() && canonical.exists() {
        fs::rename(&canonical, &moved_v2)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    if !moved_legacy.exists() && legacy.exists() {
        fs::rename(&legacy, &moved_legacy)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    if !legacy.exists() {
        fs::create_dir_all(&legacy).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    let fence_meta = fs::symlink_metadata(&legacy)
        .map_err(|_| ProjectError::code("coordination_writer_fence_missing"))?;
    if fence_meta.file_type().is_symlink() || !fence_meta.is_dir() {
        return Err(ProjectError::code("coordination_writer_fence_missing"));
    }
    if !canonical.exists() {
        fs::rename(&staged, &canonical)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    validate_candidate(&canonical)?;
    sync_directory(&dir)?;
    let mut completed = intent.clone();
    completed["status"] = json!("complete");
    write_durable_json(&intent_file, &completed)?;
    Ok(json!({
        "ok": true,
        "executionBlocked": true,
        "archive": archive,
        "heldWorkIds": plan["heldWorkIds"],
    }))
}

fn backup_inputs(dir: &Path, fingerprint: &str, inspection: &Value) -> Result<(), ProjectError> {
    let root = contained_tree(dir, ".coordination-recovery")?;
    let archive = contained_tree(dir, &format!(".coordination-recovery/{fingerprint}"))?;
    fs::create_dir_all(&archive).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    let _ = root;
    let target = archive.join(format!("received-inputs-{}.json", uuid::Uuid::new_v4()));
    let mut names = vec![
        "input-queue.jsonl".to_owned(),
        "input-cursor.json".to_owned(),
        "inbox.jsonl".to_owned(),
        "inbox-cursor.json".to_owned(),
        "scheduler.json".to_owned(),
    ];
    let mut works_list = Vec::new();
    if let Some(works) = inspection["state"]["works"].as_object() {
        works_list.extend(works.values().cloned());
    }
    if let Some(conflicts) = inspection["conflicts"].as_array() {
        for c in conflicts {
            if c["bucket"] == "works" {
                for key in ["baseline", "current", "legacy"] {
                    if c[key].is_object() {
                        works_list.push(c[key].clone());
                    }
                }
            }
        }
    }
    for work in works_list {
        if let Ok(bindings) = history_checkpoint_bindings(&work) {
            for row in bindings {
                if let Some(rf) = row["ref"].as_str().filter(|s| is_checkpoint_ref(s)) {
                    names.push(format!("checkpoints/{rf}"));
                }
            }
        }
    }
    names.sort();
    names.dedup();
    let mut files = Map::new();
    for name in names {
        let p = contained_tree(dir, &name)?;
        if !p.exists() {
            continue;
        }
        ensure_regular(&p)?;
        let before =
            fs::symlink_metadata(&p).map_err(|_| ProjectError::code("coordination_read_failed"))?;
        let body = fs::read(&p).map_err(|_| ProjectError::code("coordination_read_failed"))?;
        let after = fs::symlink_metadata(&p)
            .map_err(|_| ProjectError::code("coordination_read_changed"))?;
        if stat_token(&before) != stat_token(&after) {
            return Err(ProjectError::code("coordination_read_changed"));
        }
        files.insert(
            name,
            json!({
                "bytes": body.len() as u64,
                "sha256": sha256_hex(&body),
                "base64": encode_base64(&body),
            }),
        );
    }
    write_durable_json(
        &target,
        &json!({
            "schemaVersion": 1,
            "sourceFingerprint": fingerprint,
            "files": files,
        }),
    )
}

fn write_recovery_status(dir: &Path, status: Value) -> Result<(), ProjectError> {
    let file = contained_tree(dir, "recovery-action.json")?;
    let mut obj = status.as_object().cloned().unwrap_or_default();
    obj.insert("schemaVersion".to_owned(), json!(1));
    obj.insert("at".to_owned(), json!(now_iso()));
    write_durable_json(&file, &Value::Object(obj))
}

fn remember_recovery_view(dir: &Path, view: &Value) -> Result<(), ProjectError> {
    if view["canContinue"] != true {
        return Ok(());
    }
    let file = contained_tree(dir, "recovery-action.json")?;
    let pending = view["works"].as_array().map_or(0, Vec::len)
        + view["sessions"].as_array().map_or(0, Vec::len);
    let current = if file.exists() {
        read_json_regular(&file).ok()
    } else {
        None
    };
    let runtime_ready = view["runtimeReady"] == true;
    if let Some(ref cur) = current {
        if cur["phase"].as_str() != Some("ready") && (pending > 0 || !runtime_ready) {
            return Ok(());
        }
        if cur["phase"].as_str() == Some("ready") && cur["pending"].as_u64() == Some(pending as u64)
        {
            return Ok(());
        }
    }
    write_durable_json(
        &file,
        &json!({
            "schemaVersion": 1,
            "phase": "ready",
            "pending": pending,
            "at": now_iso(),
        }),
    )
}

struct OwnedInspection {
    dir: PathBuf,
    inspection: Value,
    state: Value,
    token: String,
    decisions: Vec<Value>,
    view: Value,
}

fn build_work_title(
    dir: &Path,
    state: &Value,
    work: &Value,
    data_home: &Path,
    workspace_id: &str,
) -> String {
    let mut text = work["title"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_default();
    if text.is_empty()
        && let Some(cp_ref) = work["checkpointRef"].as_str()
        && let Some(wid) = work["workId"].as_str()
    {
        let facts = DirCheckpointFacts {
            dir,
            state,
            safe_sessions: HashSet::new(),
        };
        if let Ok(Some(cp)) = facts.checkpoint(wid, Some(cp_ref))
            && let Some(t) = cp["job"]["userInputs"][0]["text"].as_str()
        {
            text = t.to_owned();
        }
    }
    let _ = (data_home, workspace_id);
    if text.is_empty() {
        text = "Earlier task".to_owned();
    }
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

fn inspect_owned_internal(
    data_home: &Path,
    workspace_id: &str,
    sessions: &[Value],
    is_ready: bool,
) -> Result<OwnedInspection, ProjectError> {
    let dir = workspace_runtime_dir(data_home, workspace_id)?;
    let has_intent = dir.join("coordination-recovery.json").exists();
    let saved = if has_intent {
        Some(read_saved_inspection(&dir)?)
    } else {
        None
    };
    let restored = saved
        .as_ref()
        .is_some_and(|(intent, _)| intent["status"].as_str() == Some("complete"));
    let inspection = match saved.as_ref() {
        Some((_, insp)) => insp.clone(),
        None => inspect_coordination_fork(&dir)?,
    };
    let published = if restored {
        let generation = saved
            .as_ref()
            .and_then(|(i, _)| i["generation"].as_str())
            .unwrap_or("");
        Some(read_recovered_coordination(&dir, generation)?)
    } else {
        None
    };
    let state = published
        .as_ref()
        .map(|(st, _)| st.clone())
        .unwrap_or_else(|| inspection["state"].clone());
    let admitted = state["lastRecovery"]["executionBlocked"] == false;

    let mut non_terminal_sessions = Vec::new();
    let mut safe_sessions = HashSet::new();
    for row in sessions {
        let Some(sid) = row["sessionId"].as_str() else {
            continue;
        };
        if row["terminal"] != true {
            non_terminal_sessions.push(row.clone());
        } else {
            safe_sessions.insert(sid.to_owned());
        }
        if row["safe"] == true {
            safe_sessions.insert(sid.to_owned());
        }
    }

    let facts = DirCheckpointFacts {
        dir: &dir,
        state: &state,
        safe_sessions,
    };
    let decisions =
        plan_history_resumption(&state, &inspection, &facts).map_err(ProjectError::code)?;

    let mut session_ids_sorted: Vec<&str> = non_terminal_sessions
        .iter()
        .filter_map(|s| s["sessionId"].as_str())
        .collect();
    session_ids_sorted.sort_unstable();

    let manifest_file = dir.join("coordination-v2").join("manifest.json");
    let head_file = dir.join("coordination-v2").join("head.json");
    let manifest_val = if manifest_file.exists() {
        read_json_regular(&manifest_file)?
    } else {
        Value::Null
    };
    let head_val = if head_file.exists() {
        read_json_regular(&head_file)?
    } else {
        Value::Null
    };

    let mut token_obj = Map::new();
    token_obj.insert("source".to_owned(), inspection["sourceFingerprint"].clone());
    token_obj.insert("revision".to_owned(), state["revision"].clone());
    token_obj.insert("decisions".to_owned(), Value::Array(decisions.clone()));
    if let Some((_, ref pub_src)) = published {
        token_obj.insert("publishedSource".to_owned(), json!(pub_src));
    }
    token_obj.insert("sessions".to_owned(), json!(session_ids_sorted));
    token_obj.insert("manifest".to_owned(), manifest_val);
    token_obj.insert("head".to_owned(), head_val);
    let token = sorted_json_digest(&Value::Object(token_obj));

    let completed_count = state["works"]
        .as_object()
        .map_or(0, |m| m.values().filter(|w| history_terminal(w)).count());
    let works_view: Vec<Value> = decisions
        .iter()
        .map(|row| {
            let wid = row["workId"].as_str().unwrap_or("");
            let wval = &state["works"][wid];
            json!({
                "workId": row["workId"],
                "disposition": row["disposition"],
                "reason": row["reason"],
                "title": build_work_title(&dir, &state, wval, data_home, workspace_id),
            })
        })
        .collect();
    let quarantined: HashSet<&str> = state["lastRecovery"]["quarantinedSessionIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let retained: HashSet<&str> = state["lastRecovery"]["retainedSessionIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let sessions_view: Vec<Value> = non_terminal_sessions
        .iter()
        .filter(|row| {
            let sid = row["sessionId"].as_str().unwrap_or("");
            (!admitted || quarantined.contains(sid)) && !retained.contains(sid)
        })
        .map(|row| {
            let title: String = row["title"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Earlier task")
                .chars()
                .take(160)
                .collect();
            json!({
                "sessionId": row["sessionId"],
                "title": title,
            })
        })
        .collect();

    let mut view_obj = json!({
        "phase": if admitted { "ready" } else { "inspection" },
        "planToken": token,
        "restored": restored,
        "canContinue": admitted,
        "runtimeReady": is_ready,
        "completedCount": completed_count,
        "works": works_view,
        "sessions": sessions_view,
        "backupAvailable": has_intent,
    });
    if let Some((ref intent, _)) = saved
        && let Some(arch) = intent["archive"].as_str()
    {
        view_obj["backupLocation"] = json!(dir.join(arch));
    }
    Ok(OwnedInspection {
        dir,
        inspection,
        state,
        token,
        decisions,
        view: view_obj,
    })
}

pub fn occupied_recovery_view(data_home: &Path, workspace_id: &str) -> Value {
    let lease = peer_store::HostLeaseStore::new(data_home)
        .inspect(workspace_id)
        .ok()
        .flatten();
    let mut view = json!({
        "phase": "occupied",
        "restored": false,
        "canContinue": false,
        "runtimeReady": false,
        "completedCount": 0,
        "works": [],
        "sessions": [],
        "backupAvailable": false,
    });
    if let Some(rec) = lease {
        view["holder"] = json!({
            "surface": rec.surface,
            "version": rec.app_version,
        });
    }
    json!({ "ok": true, "view": view })
}

/// Fast read check for conversation pages: `true` only while the user still has unresolved holds.
pub fn needs_recovery_attention(data_home: &Path, workspace_id: &str) -> bool {
    let Ok(dir) = workspace_runtime_dir(data_home, workspace_id) else {
        return false;
    };
    if !dir.join("coordination-recovery.json").exists() {
        return false;
    }
    let Ok(current) = read_json_regular(&dir.join("recovery-action.json")) else {
        return true;
    };
    current["phase"].as_str() != Some("ready") || current["pending"].as_u64().is_none_or(|n| n > 0)
}

/// Inspect coordination fork / recovery state for a lease-owned workspace.
pub fn inspect_recovery(
    host: &NativeProjectHost,
    workspace_id: &str,
    sessions: &[Value],
    is_ready: bool,
) -> Result<Value, ProjectError> {
    if !host.holds_lease(workspace_id) {
        return Ok(occupied_recovery_view(host.data_home(), workspace_id));
    }
    let inspected = inspect_owned_internal(host.data_home(), workspace_id, sessions, is_ready)?;
    let _ = remember_recovery_view(&inspected.dir, &inspected.view);
    Ok(json!({ "ok": true, "view": inspected.view }))
}

fn check_owner_epoch(
    host: &NativeProjectHost,
    workspace_id: &str,
    expected_epoch: &str,
) -> Result<(), ProjectError> {
    if !host.holds_lease(workspace_id)
        || host.lease_epoch(workspace_id).as_deref() != Some(expected_epoch)
    {
        return Err(ProjectError::code("coordination_lease_lost"));
    }
    Ok(())
}

/// Restore coordination from a verified fork plan into v2 + writer fence and admit resumption.
pub fn execute_recovery_restore(
    host: &NativeProjectHost,
    workspace_id: &str,
    plan_token: &str,
    expected_epoch: &str,
    sessions: &[Value],
    is_ready: bool,
) -> Result<Value, ProjectError> {
    if !is_hex64(plan_token) {
        return Err(ProjectError::code("INVALID_INPUT"));
    }
    check_owner_epoch(host, workspace_id, expected_epoch)?;
    let plan = inspect_owned_internal(host.data_home(), workspace_id, sessions, is_ready)?;
    if plan.token != plan_token {
        return Err(ProjectError::code("coordination_resume_plan_changed"));
    }
    if plan.view["canContinue"] != true || !plan.decisions.is_empty() {
        if plan.view["canContinue"] != true || plan.view["restored"] != true {
            write_recovery_status(&plan.dir, json!({ "phase": "backing_up" }))?;
            backup_inputs(
                &plan.dir,
                plan.inspection["sourceFingerprint"].as_str().unwrap_or(""),
                &plan.inspection,
            )?;
            write_recovery_status(&plan.dir, json!({ "phase": "restoring" }))?;
            check_owner_epoch(host, workspace_id, expected_epoch)?;
            recover_fork_backup(
                &plan.dir,
                plan.inspection["sourceFingerprint"].as_str().unwrap_or(""),
                plan.inspection["baselinePrefix"]["sha256"]
                    .as_str()
                    .unwrap_or(""),
            )?;
            check_owner_epoch(host, workspace_id, expected_epoch)?;
            let manifest_file = plan.dir.join("coordination-v2").join("manifest.json");
            let head_file = plan.dir.join("coordination-v2").join("head.json");
            let mut manifest = read_json_regular(&manifest_file)?;
            let min_reader = manifest["minimumReaderVersion"]
                .as_u64()
                .unwrap_or(2)
                .max(4);
            let min_writer = manifest["minimumWriterVersion"]
                .as_u64()
                .unwrap_or(2)
                .max(4);
            manifest["minimumReaderVersion"] = json!(min_reader);
            manifest["minimumWriterVersion"] = json!(min_writer);
            write_durable_json(&manifest_file, &manifest)?;
            let mut head = read_json_regular(&head_file)?;
            let head_writer = head["minimumWriterVersion"]
                .as_u64()
                .unwrap_or(2)
                .max(min_writer);
            head["minimumWriterVersion"] = json!(head_writer);
            write_durable_json(&head_file, &head)?;
        }
        write_recovery_status(&plan.dir, json!({ "phase": "reconciling" }))?;
        let snap = host.coordination().ensure_snapshot(workspace_id)?;
        check_owner_epoch(host, workspace_id, expected_epoch)?;
        let st = &snap.state;
        let blocked = st["lastRecovery"]["executionBlocked"] != false;
        let mut safe_sessions = HashSet::new();
        for row in sessions {
            if let Some(sid) = row["sessionId"].as_str()
                && (row["terminal"] == true || row["safe"] == true)
            {
                safe_sessions.insert(sid.to_owned());
            }
        }
        let facts = DirCheckpointFacts {
            dir: &plan.dir,
            state: st,
            safe_sessions,
        };
        let decisions =
            plan_history_resumption(st, &plan.inspection, &facts).map_err(ProjectError::code)?;
        if blocked || !decisions.is_empty() {
            let mut originals = Vec::new();
            if let Some(works) = plan.inspection["state"]["works"].as_object() {
                originals.extend(works.values());
            }
            let mut q_inputs = Vec::new();
            let mut q_events = Vec::new();
            let mut seen_i = HashSet::new();
            let mut seen_e = HashSet::new();
            let collect_work = |w: &Value,
                                qi: &mut Vec<Value>,
                                qe: &mut Vec<Value>,
                                si: &mut HashSet<String>,
                                se: &mut HashSet<String>| {
                for id in w["anchorInputIds"].as_array().into_iter().flatten() {
                    if let Some(s) = id.as_str()
                        && si.insert(s.to_owned())
                    {
                        qi.push(json!(s));
                    }
                }
                for key in ["pendingEventIds", "consumedEventIds"] {
                    for id in w[key].as_array().into_iter().flatten() {
                        if let Some(s) = id.as_str()
                            && se.insert(s.to_owned())
                        {
                            qe.push(json!(s));
                        }
                    }
                }
            };
            for w in originals {
                collect_work(w, &mut q_inputs, &mut q_events, &mut seen_i, &mut seen_e);
            }
            if let Some(conflicts) = plan.inspection["conflicts"].as_array() {
                for c in conflicts {
                    if c["bucket"] == "works" {
                        for key in ["baseline", "current", "legacy"] {
                            if c[key].is_object() {
                                collect_work(
                                    &c[key],
                                    &mut q_inputs,
                                    &mut q_events,
                                    &mut seen_i,
                                    &mut seen_e,
                                );
                            }
                        }
                    }
                }
            }
            let q_sessions: Vec<Value> = plan.view["sessions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| row.get("sessionId").cloned())
                .collect();
            let expected_rev = st["revision"].as_u64().unwrap_or(0);
            let fp = plan.inspection["sourceFingerprint"].as_str().unwrap_or("");
            host.coordination().append_event(
                workspace_id,
                json!({
                    "kind": "history_resume_admitted",
                    "sourceFingerprint": fp,
                    "expectedRevision": expected_rev,
                    "decisions": decisions,
                    "quarantinedSessionIds": q_sessions,
                    "quarantinedInputIds": q_inputs,
                    "quarantinedEventIds": q_events,
                }),
            )?;
        }
    }
    write_recovery_status(&plan.dir, json!({ "phase": "ready" }))?;
    let after = inspect_owned_internal(host.data_home(), workspace_id, sessions, is_ready)?;
    remember_recovery_view(&after.dir, &after.view)?;
    Ok(json!({ "ok": true, "view": after.view }))
}

/// Retain held historical work(s) or quarantined child session(s) as cancelled/settled facts.
#[allow(clippy::too_many_arguments)]
pub fn execute_recovery_retain(
    host: &NativeProjectHost,
    workspace_id: &str,
    action: &str,
    plan_token: &str,
    work_id: Option<&str>,
    session_id: Option<&str>,
    expected_epoch: &str,
    sessions: &[Value],
    is_ready: bool,
) -> Result<Value, ProjectError> {
    if !is_hex64(plan_token) {
        return Err(ProjectError::code("INVALID_INPUT"));
    }
    match action {
        "retain" => {
            if work_id.is_some() == session_id.is_some() {
                return Err(ProjectError::code("INVALID_INPUT"));
            }
            let target = work_id.or(session_id).unwrap_or("");
            if !is_valid_token_or_id(target, 200) {
                return Err(ProjectError::code("INVALID_INPUT"));
            }
        }
        "retain_all" => {
            if work_id.is_some() || session_id.is_some() {
                return Err(ProjectError::code("INVALID_INPUT"));
            }
        }
        _ => return Err(ProjectError::code("INVALID_INPUT")),
    }
    check_owner_epoch(host, workspace_id, expected_epoch)?;
    let plan = inspect_owned_internal(host.data_home(), workspace_id, sessions, is_ready)?;
    if plan.token != plan_token {
        return Err(ProjectError::code("coordination_resume_plan_changed"));
    }
    if plan.view["canContinue"] != true {
        return Err(ProjectError::code("coordination_resume_plan_changed"));
    }
    let fp = plan.inspection["sourceFingerprint"]
        .as_str()
        .unwrap_or("")
        .to_owned();

    if action == "retain_all" {
        let held_works: Vec<&Value> = plan
            .decisions
            .iter()
            .filter(|d| d["disposition"] == "held")
            .filter_map(|d| d["workId"].as_str())
            .map(|wid| &plan.state["works"][wid])
            .collect();
        let held_sessions: Vec<String> = plan.view["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s["sessionId"].as_str().map(str::to_owned))
            .collect();
        if (held_works.is_empty() && held_sessions.is_empty())
            || held_works.iter().any(|w| !history_work_held(w))
        {
            return Err(ProjectError::code("coordination_resume_plan_changed"));
        }
        let mut to_cancel = HashSet::new();
        for sid in &held_sessions {
            to_cancel.insert(sid.clone());
        }
        for w in &held_works {
            for sid in w["sessionIds"].as_array().into_iter().flatten() {
                if let Some(s) = sid.as_str() {
                    to_cancel.insert(s.to_owned());
                }
            }
        }
        for sid in to_cancel {
            if host
                .supervisor()
                .find_plan_by_session(workspace_id, &sid)
                .is_some()
            {
                let _ = host.supervisor().control_session(
                    workspace_id,
                    &sid,
                    "cancel",
                    "recovery_retain",
                    true,
                );
            }
        }
        check_owner_epoch(host, workspace_id, expected_epoch)?;
        let mut snap = host.coordination().ensure_snapshot(workspace_id)?;
        for w in &held_works {
            let wid = w["workId"].as_str().unwrap_or("");
            if sorted_json_digest(&snap.state["works"][wid]) != sorted_json_digest(w) {
                return Err(ProjectError::code("coordination_resume_plan_changed"));
            }
        }
        for sid in held_sessions {
            let rev = snap.state["revision"].as_u64().unwrap_or(0);
            snap = host.coordination().append_event(
                workspace_id,
                json!({
                    "kind": "history_session_retained",
                    "sessionId": sid,
                    "sourceFingerprint": fp,
                    "expectedRevision": rev,
                }),
            )?;
        }
        for w in held_works {
            let wid = w["workId"].as_str().unwrap_or("");
            let fresh = &snap.state["works"][wid];
            let rev = snap.state["revision"].as_u64().unwrap_or(0);
            snap = host.coordination().append_event(
                workspace_id,
                json!({
                    "kind": "history_work_retained",
                    "workId": wid,
                    "workHash": sorted_json_digest(fresh),
                    "sourceFingerprint": fp,
                    "expectedRevision": rev,
                }),
            )?;
        }
    } else if let Some(sid) = session_id {
        let found = plan.view["sessions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row["sessionId"].as_str() == Some(sid));
        if !found {
            return Err(ProjectError::code("coordination_resume_plan_changed"));
        }
        if host
            .supervisor()
            .find_plan_by_session(workspace_id, sid)
            .is_some()
        {
            let _ = host.supervisor().control_session(
                workspace_id,
                sid,
                "cancel",
                "recovery_retain",
                true,
            );
        }
        check_owner_epoch(host, workspace_id, expected_epoch)?;
        let snap = host.coordination().ensure_snapshot(workspace_id)?;
        let rev = snap.state["revision"].as_u64().unwrap_or(0);
        host.coordination().append_event(
            workspace_id,
            json!({
                "kind": "history_session_retained",
                "sessionId": sid,
                "sourceFingerprint": fp,
                "expectedRevision": rev,
            }),
        )?;
    } else if let Some(wid) = work_id {
        let work = &plan.state["works"][wid];
        if !history_work_held(work) {
            return Err(ProjectError::code("coordination_resume_plan_changed"));
        }
        for sid in work["sessionIds"].as_array().into_iter().flatten() {
            if let Some(s) = sid.as_str()
                && host
                    .supervisor()
                    .find_plan_by_session(workspace_id, s)
                    .is_some()
            {
                let _ = host.supervisor().control_session(
                    workspace_id,
                    s,
                    "cancel",
                    "recovery_retain",
                    true,
                );
            }
        }
        check_owner_epoch(host, workspace_id, expected_epoch)?;
        let snap = host.coordination().ensure_snapshot(workspace_id)?;
        let fresh = &snap.state["works"][wid];
        if sorted_json_digest(fresh) != sorted_json_digest(work) {
            return Err(ProjectError::code("coordination_resume_plan_changed"));
        }
        let rev = snap.state["revision"].as_u64().unwrap_or(0);
        host.coordination().append_event(
            workspace_id,
            json!({
                "kind": "history_work_retained",
                "workId": wid,
                "workHash": sorted_json_digest(fresh),
                "sourceFingerprint": fp,
                "expectedRevision": rev,
            }),
        )?;
    }

    write_recovery_status(&plan.dir, json!({ "phase": "ready" }))?;
    let after = inspect_owned_internal(host.data_home(), workspace_id, sessions, is_ready)?;
    remember_recovery_view(&after.dir, &after.view)?;
    Ok(json!({ "ok": true, "view": after.view }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LeaseStatus;
    use peer_protocol::javascript_json_string;
    use tempfile::tempdir;

    fn seed_forked_workspace(home: &Path, ws_path: &Path) -> (NativeProjectHost, String) {
        let host = NativeProjectHost::new(home, "0.1.0-test", None).unwrap();
        let (entry, _) = host.bind_workspace(ws_path, Some("Fork")).unwrap();
        let ws_id = entry.workspace_id.clone();
        assert!(matches!(
            host.ensure_lease(&ws_id).unwrap(),
            LeaseStatus::Acquired { .. }
        ));
        let cp_dir = home
            .join("project-runtime")
            .join(&ws_id)
            .join("checkpoints");
        fs::create_dir_all(&cp_dir).unwrap();

        let make_cp = |owner: &str, payload: Value| -> String {
            let bytes = serde_json::to_vec(&payload).unwrap();
            let mut buf = Vec::new();
            buf.extend_from_slice(owner.as_bytes());
            buf.push(b'\n');
            buf.extend_from_slice(&bytes);
            let name = format!("{}.json", sha256_hex(&buf));
            fs::write(cp_dir.join(&name), bytes).unwrap();
            name
        };

        let make_work = |wid: &str, note: Option<&str>, anchors: Value| -> Value {
            let native_ref = make_cp(
                &format!("{wid}:attempt"),
                json!({ "provider": "test", "messages": [] }),
            );
            let job_ref = make_cp(
                wid,
                json!({
                    "job": {
                        "workId": wid,
                        "kind": "user",
                        "userInputs": [{ "inputId": wid, "text": "task" }]
                    },
                    "outcome": {
                        "yielded": true,
                        "rounds": [{
                            "toolCalls": [{ "toolCallId": "tc-1", "result": { "ok": true } }]
                        }]
                    }
                }),
            );
            let mut w = json!({
                "workId": wid,
                "workspaceId": ws_id,
                "parentConversationId": "parent",
                "state": "runnable",
                "anchorInputIds": anchors,
                "sessionIds": [],
                "checkpointRef": job_ref,
                "nativeCheckpointRef": native_ref,
                "budget": {
                    "tokens": 7,
                    "toolCalls": 1,
                    "attempts": {
                        "attempt": {
                            "role": "project_agent",
                            "checkpointRef": native_ref,
                            "pendingTools": []
                        }
                    }
                }
            });
            if let Some(n) = note {
                w["note"] = json!(n);
            }
            w
        };

        let ws_dir = home.join("project-runtime").join(&ws_id);
        let legacy_file = ws_dir.join("coordination.jsonl");
        let conflict = make_work("conflict", None, json!(["conflict"]));
        let safe = make_work("safe", None, json!(["safe"]));
        let events = [
            json!({
                "schemaVersion": 1,
                "revision": 1,
                "kind": "work",
                "work": { "workId": "done", "state": "delivered", "anchorInputIds": ["finished-input"] },
            }),
            json!({ "schemaVersion": 1, "revision": 2, "kind": "work", "work": conflict }),
            json!({ "schemaVersion": 1, "revision": 3, "kind": "work", "work": safe }),
        ];
        let mut legacy_raw = String::new();
        for ev in &events {
            legacy_raw.push_str(&serde_json::to_string(ev).unwrap());
            legacy_raw.push('\n');
        }
        fs::write(&legacy_file, &legacy_raw).unwrap();
        let meta_before = fs::symlink_metadata(&legacy_file).unwrap();
        let legacy_ver = stat_token(&meta_before);
        let generation = uuid::Uuid::new_v4().to_string();

        // Build healthy v2 segment from baseline + 1 event on v2
        let v2_dir = ws_dir.join("coordination-v2");
        fs::create_dir_all(v2_dir.join("segments")).unwrap();
        let seg_event = {
            let mut c2 = safe.clone();
            c2["note"] = json!("current");
            let mut body = json!({
                "schemaVersion": 1,
                "storageVersion": 2,
                "revision": 4,
                "previousHash": "",
                "kind": "work",
                "work": c2,
            });
            let digest = javascript_json_digest(&body).unwrap();
            body["hash"] = json!(digest);
            body
        };
        let seg_hash = seg_event["hash"].as_str().unwrap().to_owned();
        let seg_line = format!("{}\n", javascript_json_string(&seg_event).unwrap());
        fs::write(v2_dir.join("segments/000000000001.jsonl"), seg_line).unwrap();
        fs::write(
            v2_dir.join("manifest.json"),
            serde_json::to_vec(&json!({
                "schemaVersion": 2,
                "minimumReaderVersion": 2,
                "minimumWriterVersion": 2,
                "generation": generation,
                "legacyFile": "coordination.jsonl",
                "legacyVersion": legacy_ver,
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            v2_dir.join("head.json"),
            serde_json::to_vec(&json!({
                "generation": generation,
                "legacyVersion": legacy_ver,
                "revision": 4,
                "hash": seg_hash,
                "minimumWriterVersion": 2,
            }))
            .unwrap(),
        )
        .unwrap();

        // Now append conflicting record to legacy coordination.jsonl creating a fork!
        let mut forked_conflict = conflict;
        forked_conflict["note"] = json!("legacy");
        forked_conflict["anchorInputIds"] = json!(["legacy-input"]);
        let fork_ev = json!({
            "schemaVersion": 1,
            "epoch": "legacy-owner",
            "revision": 4,
            "kind": "work",
            "work": forked_conflict,
        });
        legacy_raw.push_str(&serde_json::to_string(&fork_ev).unwrap());
        legacy_raw.push('\n');
        fs::write(&legacy_file, &legacy_raw).unwrap();
        fs::write(ws_dir.join("input-queue.jsonl"), "keep-me\n").unwrap();

        (host, ws_id)
    }

    #[test]
    fn inspect_restore_and_retain_coordination_fork_end_to_end() {
        let home = tempdir().unwrap();
        let ws_path = tempdir().unwrap();
        let (host, ws_id) = seed_forked_workspace(home.path(), ws_path.path());

        assert!(!needs_recovery_attention(home.path(), &ws_id));
        let sessions = vec![json!({
            "sessionId": "orphan-child",
            "title": "Historical child",
            "terminal": false,
        })];
        let before = inspect_recovery(&host, &ws_id, &sessions, true).unwrap();
        assert_eq!(before["ok"], true);
        let token = before["view"]["planToken"].as_str().unwrap().to_owned();
        let epoch = host.lease_epoch(&ws_id).unwrap();

        // Wrong token must reject cleanly
        let bad = execute_recovery_restore(&host, &ws_id, &"0".repeat(64), &epoch, &sessions, true);
        assert!(bad.is_err());

        let restored =
            execute_recovery_restore(&host, &ws_id, &token, &epoch, &sessions, true).unwrap();
        assert_eq!(restored["ok"], true);
        assert_eq!(restored["view"]["canContinue"], true);
        assert!(needs_recovery_attention(home.path(), &ws_id));

        let ws_dir = home.path().join("project-runtime").join(&ws_id);
        assert!(ws_dir.join("coordination.jsonl").is_dir());
        assert_eq!(
            fs::read_to_string(ws_dir.join("input-queue.jsonl")).unwrap(),
            "keep-me\n"
        );

        let snap = host.coordination().ensure_snapshot(&ws_id).unwrap();
        assert_eq!(snap.state["works"]["done"]["state"], "delivered");
        assert_eq!(snap.state["works"]["safe"]["state"], "runnable");
        assert_eq!(snap.state["works"]["conflict"]["state"], "blocked_system");

        let next_view = inspect_recovery(&host, &ws_id, &sessions, true).unwrap();
        let next_token = next_view["view"]["planToken"].as_str().unwrap().to_owned();
        let retained = execute_recovery_retain(
            &host,
            &ws_id,
            "retain_all",
            &next_token,
            None,
            None,
            &epoch,
            &sessions,
            true,
        )
        .unwrap();
        assert_eq!(retained["ok"], true);
        assert_eq!(retained["view"]["works"], json!([]));
        assert_eq!(retained["view"]["sessions"], json!([]));
        assert!(!needs_recovery_attention(home.path(), &ws_id));
    }
}
