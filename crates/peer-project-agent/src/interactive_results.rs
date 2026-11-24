//! Native Interactive Results domain store, observation capture, retention/tombstone
//! cleanup, and governed inspection (`local.interactive.inspect`).
//!
//! Matches `packages/runtime-node/src/interactive-results/{storage,store,capture,retention,text-reader,provider}.mjs`
//! and stays 100% on-disk compatible with `crates/peer-store/src/interactive_result/`.

use crate::{ProjectError, memory_secret_reason, now_iso};
use peer_protocol::interactive_result::{
    INTERACTIVE_FALLBACK_BYTES, INTERACTIVE_MANIFEST_BYTES, INTERACTIVE_PUBLISH_CAPABILITY,
    INTERACTIVE_PUBLISH_TOOL, INTERACTIVE_RESULT_PREFIX, InteractiveOwner,
    InteractiveResultReference, InteractiveResultSource, interactive_canonical_json,
    interactive_digest, interactive_json_digest, interactive_token,
};
use peer_runtime::CancellationToken;
use peer_store::{DirectoryLock, EvidenceIndexStore};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, OpenOptions},
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const INTERACTIVE_INSPECT_CAPABILITY: &str = "local.interactive.inspect";
pub const INTERACTIVE_INSPECT_TOOL: &str = "inspect_interactive_result";
pub const INTERACTIVE_RESULTS_PER_BOT: usize = 256;
pub const INTERACTIVE_STORE_BYTES: usize = 128 * 1024 * 1024;
pub const INTERACTIVE_TOMBSTONE_LIMIT: usize = 256;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const CLEANUP_CATEGORY: &str = "interactive-cleanup";
const LIBRARY_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InteractiveValidationError {
    pub code: String,
    pub path: String,
    pub details: String,
}

impl InteractiveValidationError {
    pub fn new(
        code: impl Into<String>,
        path: impl Into<String>,
        details: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            path: path.into(),
            details: details.into(),
        }
    }
}

/// Host-supplied bridge to `@peer-agent/interactive-content` (OpenUI DSL validator
/// and bounded pure evaluator). Desktop mounts this over reverse RPC (`peer-core-rpc`);
/// CLI / TUI leaves it unmounted so graphics/JS dependencies never enter CLI startup.
pub trait InteractiveContentBridge: Send + Sync {
    fn validate_draft(
        &self,
        draft: Value,
        bindings: Value,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Value, InteractiveValidationError>> + Send>>;

    fn evaluate_content(
        &self,
        content: Value,
        values: Value,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Value, InteractiveValidationError>> + Send>>;

    fn catalog_prompt(&self) -> Option<String>;
}

/// Read `projectAgent.interactiveResults` from `<data_home>/settings.json`.
/// Defaults safely to `false` on absent or malformed files.
pub fn is_interactive_results_enabled_in_settings(data_home: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(data_home.join("settings.json")) else {
        return false;
    };
    serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| v["projectAgent"]["interactiveResults"].as_bool())
        == Some(true)
}

const DATA_LEVELS: [&str; 5] = [
    "D0_public",
    "D1_internal",
    "D2_sensitive",
    "D3_private",
    "D4_regulated",
];

fn data_level_rank(level: &str) -> Option<usize> {
    DATA_LEVELS.iter().position(|&l| l == level)
}

fn max_data_level(a: &str, b: &str) -> Option<String> {
    let ra = data_level_rank(a)?;
    let rb = data_level_rank(b)?;
    Some(DATA_LEVELS[ra.max(rb)].to_owned())
}

fn canonical_eq(a: &Value, b: &Value) -> bool {
    interactive_canonical_json(a).ok() == interactive_canonical_json(b).ok()
}

fn encode_canonical(v: &Value) -> Result<String, ProjectError> {
    interactive_canonical_json(v).map_err(|_| ProjectError::code("interactive_storage_corrupt"))
}

fn json_digest(v: &Value) -> Result<String, ProjectError> {
    interactive_json_digest(v).map_err(|_| ProjectError::code("interactive_storage_corrupt"))
}

fn interactive_artifact_ref(reference: &InteractiveResultReference) -> String {
    reference.locator()
}

/// Extract up to 20 deduplicated, valid `interactive-result://...` locators from evidence refs.
pub fn task_result_references(refs: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in refs {
        if raw.starts_with(INTERACTIVE_RESULT_PREFIX)
            && InteractiveResultReference::parse(raw).is_some()
            && seen.insert(raw.clone())
        {
            out.push(raw.clone());
            if out.len() >= 20 {
                break;
            }
        }
    }
    out
}

fn strip_provenance_timestamps(provenance: &[Value]) -> Vec<Value> {
    provenance
        .iter()
        .cloned()
        .map(|mut rec| {
            if let Some(obj) = rec.as_object_mut() {
                obj.remove("capturedAt");
                if obj
                    .get("source")
                    .and_then(|s| s.get("kind"))
                    .and_then(Value::as_str)
                    == Some("model-data")
                {
                    obj.remove("observedAt");
                }
            }
            rec
        })
        .collect()
}

fn content_digest(
    content: &Value,
    provenance: &[Value],
    data_level: &str,
) -> Result<String, ProjectError> {
    let stripped = strip_provenance_timestamps(provenance);
    json_digest(&json!({
        "encoding": "peer-interactive-content-1",
        "content": content,
        "provenance": stripped,
        "dataLevel": data_level,
    }))
}

fn truncate_utf16_units(input: &str, max_units: usize) -> (String, bool) {
    let mut used = 0usize;
    let mut end = input.len();
    let mut truncated = false;
    for (idx, ch) in input.char_indices() {
        let w = ch.len_utf16();
        if used + w > max_units {
            end = idx;
            truncated = true;
            break;
        }
        used += w;
    }
    (input[..end].to_owned(), truncated)
}

fn redact_value(value: &Value) -> (Value, bool) {
    match value {
        Value::String(s) => {
            if memory_secret_reason(s).is_some() {
                (Value::String("[REDACTED]".to_owned()), true)
            } else {
                (Value::String(s.clone()), false)
            }
        }
        Value::Array(arr) => {
            let mut changed = false;
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                let (v, r) = redact_value(item);
                changed |= r;
                out.push(v);
            }
            (Value::Array(out), changed)
        }
        Value::Object(map) => {
            let mut changed = false;
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let (rv, r) = redact_value(v);
                changed |= r;
                out.insert(k.clone(), rv);
            }
            (Value::Object(out), changed)
        }
        other => (other.clone(), false),
    }
}

fn page_text(raw: &str, offset: Option<u64>, limit: Option<u64>) -> Result<Value, ProjectError> {
    let units: Vec<u16> = raw.encode_utf16().collect();
    let off = offset.unwrap_or(0) as usize;
    let lim = limit.unwrap_or(4000).clamp(1, 4000) as usize;
    if off > units.len() {
        return Err(ProjectError::code("interactive_range_exceeded"));
    }
    let end = (off + lim).min(units.len());
    let sliced = String::from_utf16_lossy(&units[off..end]);
    let truncated = end < units.len();
    let mut out = json!({
        "text": sliced,
        "offset": off,
        "limit": lim,
        "total": units.len(),
        "truncated": truncated,
    });
    if truncated {
        out["nextOffset"] = json!(end);
    }
    Ok(out)
}

fn select_data(root: &Value, selector: Option<&Value>) -> Result<Value, ProjectError> {
    let Some(sel) = selector.filter(|v| v.is_object()) else {
        return Ok(root.clone());
    };
    let mut cur = root.clone();
    if let Some(path) = sel.get("path").and_then(Value::as_array) {
        if path.len() > 8 {
            return Err(ProjectError::code("interactive_inspect_invalid"));
        }
        for seg in path {
            let Some(key) = seg.as_str() else {
                return Err(ProjectError::code("interactive_inspect_invalid"));
            };
            cur = match cur {
                Value::Object(ref map) => map
                    .get(key)
                    .cloned()
                    .ok_or_else(|| ProjectError::code("interactive_binding_unavailable"))?,
                Value::Array(ref arr) => {
                    let idx: usize = key
                        .parse()
                        .map_err(|_| ProjectError::code("interactive_binding_unavailable"))?;
                    arr.get(idx)
                        .cloned()
                        .ok_or_else(|| ProjectError::code("interactive_binding_unavailable"))?
                }
                _ => return Err(ProjectError::code("interactive_binding_unavailable")),
            };
        }
    }
    if let Some(arr) = cur.as_array() {
        let start = sel.get("start").and_then(Value::as_u64).unwrap_or(0) as usize;
        let limit = sel.get("limit").and_then(Value::as_u64).unwrap_or(500) as usize;
        let end = start.saturating_add(limit).min(arr.len());
        let slice = if start >= arr.len() {
            &[][..]
        } else {
            &arr[start..end]
        };
        if let Some(fields) = sel.get("fields").and_then(Value::as_array) {
            let keys: Vec<&str> = fields.iter().filter_map(Value::as_str).collect();
            let projected: Vec<Value> = slice
                .iter()
                .map(|row| {
                    let mut m = serde_json::Map::new();
                    for &k in &keys {
                        if let Some(v) = row.get(k) {
                            m.insert(k.to_owned(), v.clone());
                        }
                    }
                    Value::Object(m)
                })
                .collect();
            return Ok(Value::Array(projected));
        }
        return Ok(Value::Array(slice.to_vec()));
    }
    if let (Some(fields), Some(obj)) =
        (sel.get("fields").and_then(Value::as_array), cur.as_object())
    {
        let mut m = serde_json::Map::new();
        for f in fields {
            if let Some(k) = f.as_str()
                && let Some(v) = obj.get(k)
            {
                m.insert(k.to_owned(), v.clone());
            }
        }
        return Ok(Value::Object(m));
    }
    Ok(cur)
}

pub(crate) fn page_interactive_text(
    raw: &str,
    offset: Option<u64>,
    limit: Option<u64>,
) -> Result<Value, ProjectError> {
    page_text(raw, offset, limit)
}

pub(crate) fn select_interactive_data(
    root: &Value,
    selector: Option<&Value>,
) -> Result<Value, ProjectError> {
    select_data(root, selector)
}

#[derive(Debug, Clone)]
pub struct ValidatedPublicationRequest {
    pub owner: InteractiveOwner,
    pub source: InteractiveResultSource,
    pub publication_kind: String,
    pub base: Option<InteractiveResultReference>,
    pub normalized_draft: Value,
    pub validated_content: Value,
    pub provenance: Vec<Value>,
    pub data_level: String,
    pub grant_id: String,
    pub stream_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PublishInteractiveRequest {
    pub owner: InteractiveOwner,
    pub source: InteractiveResultSource,
    pub publication_kind: String,
    pub base: Option<InteractiveResultReference>,
    pub title: String,
    pub text_fallback: String,
    pub program: String,
    pub bindings: Value,
    pub provenance: Vec<Value>,
    pub data_level: String,
    pub grant_id: String,
    pub stream_id: Option<String>,
}

pub struct InteractiveResultStore {
    data_home: PathBuf,
}

impl InteractiveResultStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
        }
    }

    fn db_dir(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !interactive_token(workspace_id) {
            return Err(ProjectError::code("interactive_storage_unavailable"));
        }
        Ok(self
            .data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("interactive-results"))
    }

    fn db_path(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        Ok(self.db_dir(workspace_id)?.join("store.sqlite"))
    }

    fn open_rw(&self, workspace_id: &str) -> Result<Connection, ProjectError> {
        let dir = self.db_dir(workspace_id)?;
        fs::create_dir_all(&dir)
            .map_err(|e| ProjectError::new("interactive_storage_unavailable", e.to_string()))?;
        let path = dir.join("store.sqlite");
        let conn = Connection::open(&path)
            .map_err(|e| ProjectError::new("interactive_storage_unavailable", e.to_string()))?;
        conn.execute_batch(
            "PRAGMA busy_timeout = 5000;
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA journal_size_limit = 8388608;
             PRAGMA wal_autocheckpoint = 128;",
        )
        .map_err(|e| ProjectError::new("interactive_storage_incompatible", e.to_string()))?;

        let ver: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| ProjectError::code("interactive_storage_incompatible"))?;
        if ver == 0 {
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE objects(hash TEXT PRIMARY KEY, body TEXT NOT NULL, bytes INTEGER NOT NULL);
                 CREATE TABLE results(id TEXT PRIMARY KEY, owner TEXT NOT NULL, head TEXT NOT NULL);
                 CREATE TABLE versions(id TEXT NOT NULL, version TEXT NOT NULL, owner TEXT NOT NULL, object TEXT NOT NULL, metadata TEXT NOT NULL, availability TEXT NOT NULL DEFAULT 'available', PRIMARY KEY(id,version));
                 CREATE TABLE operations(id TEXT PRIMARY KEY, owner TEXT NOT NULL, conversation TEXT NOT NULL, toolCallId TEXT NOT NULL, argsDigest TEXT NOT NULL, phase TEXT NOT NULL, receipt TEXT NOT NULL);
                 CREATE TABLE states(id TEXT NOT NULL, version TEXT NOT NULL, snapshot TEXT NOT NULL, writer TEXT, PRIMARY KEY(id,version));
                 CREATE TABLE saves(id TEXT NOT NULL, version TEXT NOT NULL, requestId TEXT NOT NULL, argsDigest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(id,version,requestId));
                 CREATE TABLE followups(id TEXT PRIMARY KEY, owner TEXT NOT NULL, argsDigest TEXT NOT NULL, snapshot TEXT NOT NULL);
                 CREATE TABLE materials(id TEXT PRIMARY KEY, owner TEXT NOT NULL, object TEXT NOT NULL, metadata TEXT NOT NULL);
                 CREATE TABLE attempts(id TEXT PRIMARY KEY, body TEXT NOT NULL);
                 CREATE TABLE publication_candidates(id TEXT PRIMARY KEY, failures INTEGER NOT NULL, active TEXT);
                 CREATE TABLE owner_privacy(owner TEXT PRIMARY KEY, dataLevel TEXT NOT NULL);
                 CREATE TABLE presentation(category TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(category,id,owner));
                 PRAGMA user_version = 5;
                 COMMIT;",
            )
            .map_err(|e| ProjectError::new("interactive_storage_corrupt", e.to_string()))?;
        } else if ver != 5 {
            return Err(ProjectError::code("interactive_storage_incompatible"));
        }
        Ok(conn)
    }

    fn open_ro(&self, workspace_id: &str) -> Result<Option<Connection>, ProjectError> {
        let path = self.db_path(workspace_id)?;
        if !path.is_file() {
            return Ok(None);
        }
        let conn = Connection::open(&path)
            .map_err(|e| ProjectError::new("interactive_storage_unavailable", e.to_string()))?;
        conn.execute_batch("PRAGMA busy_timeout = 5000;")
            .map_err(|_| ProjectError::code("interactive_storage_incompatible"))?;
        let ver: u32 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| ProjectError::code("interactive_storage_incompatible"))?;
        if ver != 5 {
            return Err(ProjectError::code("interactive_storage_incompatible"));
        }
        Ok(Some(conn))
    }

    fn enforce_budgets(conn: &Connection) -> Result<(), ProjectError> {
        let stored: i64 = conn
            .query_row("SELECT COALESCE(SUM(bytes), 0) FROM objects", [], |r| {
                r.get(0)
            })
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let mut manifest: i64 = 0;
        let mut metadata: i64 = 0;
        for (table, col, counts_manifest) in [
            ("versions", "metadata", true),
            ("operations", "receipt", true),
            ("states", "snapshot", false),
            ("followups", "snapshot", false),
            ("materials", "metadata", true),
            ("saves", "receipt", false),
            ("attempts", "body", true),
            ("presentation", "body", false),
        ] {
            let sql = format!("SELECT COALESCE(SUM(length(CAST({col} AS BLOB))), 0) FROM {table}");
            let bytes: i64 = conn
                .query_row(&sql, [], |r| r.get(0))
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            if counts_manifest {
                manifest += bytes;
            }
            metadata += bytes;
        }
        let privacy: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(length(CAST(owner AS BLOB)) + length(dataLevel)), 0) FROM owner_privacy",
                [],
                |r| r.get(0),
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        if (stored + metadata + privacy) as usize > INTERACTIVE_STORE_BYTES {
            return Err(ProjectError::code("interactive_store_limit"));
        }
        if manifest as usize > INTERACTIVE_MANIFEST_BYTES {
            return Err(ProjectError::code("interactive_manifest_limit"));
        }
        Ok(())
    }

    fn put_object(conn: &Connection, value: &Value) -> Result<String, ProjectError> {
        let body = encode_canonical(value)?;
        let hash = json_digest(value)?;
        let bytes = body.len() as i64;
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT body, bytes FROM objects WHERE hash = ?1",
                params![hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        if let Some((prev_body, prev_bytes)) = existing {
            if prev_bytes != bytes || prev_body != body {
                return Err(ProjectError::code("interactive_storage_corrupt"));
            }
        } else {
            conn.execute(
                "INSERT INTO objects(hash, body, bytes) VALUES(?1, ?2, ?3)",
                params![hash, body, bytes],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        }
        Ok(hash)
    }

    fn read_object(conn: &Connection, hash: &str) -> Result<Value, ProjectError> {
        let row: Option<(String, i64)> = conn
            .query_row(
                "SELECT body, bytes FROM objects WHERE hash = ?1",
                params![hash],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let Some((body, bytes)) = row else {
            return Err(ProjectError::code("interactive_content_missing"));
        };
        if body.len() as i64 != bytes {
            return Err(ProjectError::code("interactive_content_missing"));
        }
        let val: Value = serde_json::from_str(&body)
            .map_err(|_| ProjectError::code("interactive_content_corrupt"))?;
        if json_digest(&val)? != hash {
            return Err(ProjectError::code("interactive_content_corrupt"));
        }
        Ok(val)
    }

    fn validate_owner(owner: &InteractiveOwner) -> Result<(), ProjectError> {
        if !interactive_token(&owner.workspace_id) || !interactive_token(&owner.conversation_id) {
            return Err(ProjectError::code("interactive_owner_invalid"));
        }
        Ok(())
    }

    fn operation_key(
        owner: &InteractiveOwner,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> Result<String, ProjectError> {
        json_digest(&json!([owner, conversation_id, tool_call_id]))
    }

    fn remember_privacy(
        conn: &Connection,
        owner_json: &str,
        level: &str,
    ) -> Result<(), ProjectError> {
        let prev: Option<String> = conn
            .query_row(
                "SELECT dataLevel FROM owner_privacy WHERE owner = ?1",
                params![owner_json],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let next = match prev {
            Some(ref old) => max_data_level(old, level)
                .ok_or_else(|| ProjectError::code("material_classification_unavailable"))?,
            None => level.to_owned(),
        };
        conn.execute(
            "INSERT INTO owner_privacy(owner, dataLevel) VALUES(?1, ?2)
             ON CONFLICT(owner) DO UPDATE SET dataLevel = excluded.dataLevel",
            params![owner_json, next],
        )
        .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        Ok(())
    }

    fn read_privacy(
        conn: &Connection,
        owner_json: &str,
        minimum: &str,
    ) -> Result<String, ProjectError> {
        let prev: Option<String> = conn
            .query_row(
                "SELECT dataLevel FROM owner_privacy WHERE owner = ?1",
                params![owner_json],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        match prev {
            Some(old) => max_data_level(&old, minimum)
                .ok_or_else(|| ProjectError::code("material_classification_unavailable")),
            None => Ok(minimum.to_owned()),
        }
    }

    pub fn owner_data_level(
        &self,
        owner: &InteractiveOwner,
        minimum: &str,
    ) -> Result<String, ProjectError> {
        Self::validate_owner(owner)?;
        if data_level_rank(minimum).is_none() {
            return Err(ProjectError::code("material_classification_unavailable"));
        }
        let Some(conn) = self.open_ro(&owner.workspace_id)? else {
            return Ok(minimum.to_owned());
        };
        let owner_val = serde_json::to_value(owner).unwrap();
        let owner_str = encode_canonical(&owner_val)?;
        Self::read_privacy(&conn, &owner_str, minimum)
    }

    /// Commit an interactive result whose OpenUI `content` was already validated by
    /// `@peer-agent/interactive-content` (`validateDraft`), preserving exact `libraryVersion`,
    /// `specHash`, `stateSchemaHash`, `stateSchema`, `initialValues`, and `bindings` so
    /// Desktop's OpenUI renderer opens and evaluates it with 100% schema fidelity.
    pub fn commit_validated_publication(
        &self,
        req: &ValidatedPublicationRequest,
        holds_lease: bool,
    ) -> Result<Value, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        Self::validate_owner(&req.owner)?;
        if !req.source.is_valid()
            || req
                .source
                .execution_epoch
                .as_deref()
                .is_none_or(str::is_empty)
            || data_level_rank(&req.data_level).is_none()
            || !interactive_token(&req.grant_id)
        {
            return Err(ProjectError::code(
                "interactive_publication_authority_invalid",
            ));
        }
        if !matches!(req.publication_kind.as_str(), "create" | "revise") {
            return Err(ProjectError::code("invalid_publication_intent"));
        }
        if req.publication_kind == "revise" && req.base.is_none() {
            return Err(ProjectError::code("interactive_reference_invalid"));
        }

        let mut content = req.validated_content.clone();
        let Some(content_obj) = content.as_object_mut() else {
            return Err(ProjectError::code("interactive_content_invalid"));
        };
        // Strip cached evaluated tree (matching TS `store.mjs#storedContent`).
        content_obj.remove("tree");
        if content_obj.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || !content_obj.get("program").is_some_and(Value::is_string)
            || !content_obj
                .get("specHash")
                .and_then(Value::as_str)
                .is_some_and(interactive_digest)
            || !content_obj
                .get("stateSchemaHash")
                .and_then(Value::as_str)
                .is_some_and(interactive_digest)
        {
            return Err(ProjectError::code("interactive_content_invalid"));
        }
        let trimmed_title = content_obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 160 && !s.contains('\0'))
            .ok_or_else(|| ProjectError::code("interactive_content_invalid"))?
            .to_owned();
        let spec_hash = content_obj["specHash"]
            .as_str()
            .unwrap_or("")
            .to_owned();

        let args_digest = json_digest(&req.normalized_draft)?;
        self.commit_prepared_publication(
            &req.owner,
            &req.source,
            &req.publication_kind,
            req.base.as_ref(),
            &trimmed_title,
            &spec_hash,
            content,
            &req.provenance,
            &req.data_level,
            &req.grant_id,
            req.stream_id.as_deref(),
            &args_digest,
        )
    }

    /// Commit a new interactive result publication (`phase = "index_pending"`), enforcing
    /// lease, owner privacy monotonicity, revision concurrency, and schema compatibility with
    /// `crates/peer-store/src/interactive_result/local.rs`.
    pub fn commit_publication(
        &self,
        req: &PublishInteractiveRequest,
        holds_lease: bool,
    ) -> Result<Value, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        Self::validate_owner(&req.owner)?;
        if !req.source.is_valid()
            || req
                .source
                .execution_epoch
                .as_deref()
                .is_none_or(str::is_empty)
            || data_level_rank(&req.data_level).is_none()
            || !interactive_token(&req.grant_id)
        {
            return Err(ProjectError::code(
                "interactive_publication_authority_invalid",
            ));
        }
        let trimmed_title = req.title.trim();
        if trimmed_title.is_empty()
            || trimmed_title.encode_utf16().count() > 160
            || trimmed_title.len() > 640
            || trimmed_title.contains('\0')
            || req.text_fallback.trim().is_empty()
            || req.text_fallback.len() > INTERACTIVE_FALLBACK_BYTES
            || req.program.trim().is_empty()
            || req.program.len() > 64 * 1024
        {
            return Err(ProjectError::code("interactive_draft_invalid"));
        }
        if !matches!(req.publication_kind.as_str(), "create" | "revise") {
            return Err(ProjectError::code("invalid_publication_intent"));
        }
        if req.publication_kind == "revise" && req.base.is_none() {
            return Err(ProjectError::code("interactive_reference_invalid"));
        }

        let draft_for_digest = json!({
            "publication": match (&req.publication_kind[..], &req.base) {
                ("revise", Some(b)) => json!({"kind": "revise", "base": b}),
                _ => json!({"kind": "create"}),
            },
            "title": trimmed_title,
            "textFallback": req.text_fallback,
            "program": req.program,
            "bindings": req.bindings,
        });
        let args_digest = json_digest(&draft_for_digest)?;

        let spec_hash = json_digest(&json!({
            "schemaVersion": 1,
            "program": req.program,
            "title": trimmed_title,
        }))?;
        let state_schema_hash = json_digest(&json!({}))?;
        let content = json!({
            "schemaVersion": 1,
            "libraryVersion": LIBRARY_VERSION,
            "title": trimmed_title,
            "textFallback": req.text_fallback,
            "program": req.program,
            "specHash": spec_hash,
            "stateSchemaHash": state_schema_hash,
            "stateSchema": {},
            "initialValues": {},
            "bindings": req.bindings,
        });

        self.commit_prepared_publication(
            &req.owner,
            &req.source,
            &req.publication_kind,
            req.base.as_ref(),
            trimmed_title,
            &spec_hash,
            content,
            &req.provenance,
            &req.data_level,
            &req.grant_id,
            req.stream_id.as_deref(),
            &args_digest,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_prepared_publication(
        &self,
        owner: &InteractiveOwner,
        source: &InteractiveResultSource,
        publication_kind: &str,
        base: Option<&InteractiveResultReference>,
        trimmed_title: &str,
        spec_hash: &str,
        content: Value,
        provenance: &[Value],
        data_level: &str,
        grant_id: &str,
        stream_id: Option<&str>,
        args_digest: &str,
    ) -> Result<Value, ProjectError> {
        let owner_val = serde_json::to_value(owner).unwrap();
        let owner_str = encode_canonical(&owner_val)?;
        let call_ref = json!({
            "owner": owner,
            "conversationId": source.conversation_id,
            "toolCallId": source.tool_call_id,
        });
        let op_id = Self::operation_key(owner, &source.conversation_id, &source.tool_call_id)?;
        let content_version = content_digest(&content, provenance, data_level)?;
        let body = json!({
            "encoding": "peer-interactive-content-1",
            "content": content,
            "provenance": provenance,
            "dataLevel": data_level,
        });

        let conn = self.open_rw(&owner.workspace_id)?;
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|_| ProjectError::code("interactive_storage_unavailable"))?;

        let tx_res: Result<Value, ProjectError> = (|| {
            // Replay guard on existing operation
            let prev_op: Option<(String, String, String)> = conn
                .query_row(
                    "SELECT argsDigest, phase, receipt FROM operations WHERE id = ?1",
                    params![op_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            if let Some((prev_digest, prev_phase, prev_receipt_raw)) = prev_op {
                if prev_digest != args_digest {
                    return Err(ProjectError::code("publication_parameter_conflict"));
                }
                let mut prev: Value = serde_json::from_str(&prev_receipt_raw)
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                prev["publicationStatus"] = json!(prev_phase);
                return Ok(prev);
            }

            let cur_privacy = Self::read_privacy(&conn, &owner_str, data_level)?;
            if cur_privacy != data_level {
                return Err(ProjectError::code("material_classification_changed"));
            }
            Self::remember_privacy(&conn, &owner_str, data_level)?;

            let mut result_id = format!("res-{}", uuid::Uuid::new_v4());
            let mut predecessor: Option<InteractiveResultReference> = None;

            if publication_kind == "revise" {
                let base_ref = base
                    .filter(|b| b.is_valid())
                    .ok_or_else(|| ProjectError::code("interactive_reference_invalid"))?;
                if base_ref.owner != *owner {
                    return Err(ProjectError::code("interactive_scope_denied"));
                }
                let head_row: Option<(String, String)> = conn
                    .query_row(
                        "SELECT owner, head FROM results WHERE id = ?1",
                        params![base_ref.result_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                let Some((head_owner, head_ver)) = head_row else {
                    return Err(ProjectError::code("interactive_result_unavailable"));
                };
                if head_owner != owner_str || head_ver != base_ref.content_version {
                    return Err(ProjectError::code("version_conflict"));
                }
                let base_ver = Self::load_version_inner(&conn, base_ref, false, false)?;
                result_id = base_ref.result_id.clone();
                if content_version == base_ref.content_version {
                    let base_meta = base_ver.0;
                    let unchanged = json!({
                        "reference": base_ref,
                        "callRef": call_ref,
                        "argsDigest": args_digest,
                        "unchanged": true,
                        "evidenceRef": base_meta["evidenceRef"],
                        "artifactRef": base_meta["artifactRef"],
                    });
                    let encoded = encode_canonical(&unchanged)?;
                    conn.execute(
                        "INSERT INTO operations(id, owner, conversation, toolCallId, argsDigest, phase, receipt)
                         VALUES(?1, ?2, ?3, ?4, ?5, 'published', ?6)",
                        params![
                            op_id,
                            owner_str,
                            source.conversation_id,
                            source.tool_call_id,
                            args_digest,
                            encoded
                        ],
                    )
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                    Self::enforce_budgets(&conn)?;
                    let mut out = unchanged;
                    out["publicationStatus"] = json!("published");
                    return Ok(out);
                }
                predecessor = Some(base_ref.clone());
            } else {
                let count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM results r WHERE r.owner = ?1 AND (
                            NOT EXISTS (SELECT 1 FROM versions v WHERE v.id = r.id AND v.version = r.head AND v.owner = r.owner AND v.availability = 'cleaned')
                            OR EXISTS (SELECT 1 FROM versions v WHERE v.id = r.id AND v.availability <> 'cleaned')
                         )",
                        params![owner_str],
                        |r| r.get(0),
                    )
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                if count as usize >= INTERACTIVE_RESULTS_PER_BOT {
                    return Err(ProjectError::code("interactive_result_limit"));
                }
            }

            let reference = InteractiveResultReference {
                owner: owner.clone(),
                result_id: result_id.clone(),
                content_version: content_version.clone(),
            };
            let artifact_ref = interactive_artifact_ref(&reference);
            let evidence_ref = artifact_ref.clone();
            let created_at = now_iso();

            let mut metadata = json!({
                "reference": reference,
                "source": source,
                "evidenceRef": evidence_ref,
                "artifactRef": artifact_ref,
                "dataLevel": data_level,
                "createdAt": created_at,
                "operationId": op_id,
            });
            if let Some(ref pred) = predecessor {
                metadata["predecessor"] = json!(pred);
            }

            let user_artifact = json!({
                "kind": "interactive",
                "ref": artifact_ref,
                "label": trimmed_title,
                "reference": reference,
                "specHash": spec_hash,
            });

            let mut index_entry = json!({
                "evidenceRef": evidence_ref,
                "planId": source.plan_id,
                "conversationId": source.conversation_id,
                "toolCallId": source.tool_call_id,
                "capabilityId": INTERACTIVE_PUBLISH_CAPABILITY,
                "toolName": INTERACTIVE_PUBLISH_TOOL,
                "createdAt": created_at,
                "artifactRefs": [artifact_ref],
                "userArtifacts": [user_artifact],
            });
            if let Some(sid) = stream_id
                && !sid.is_empty()
            {
                index_entry["streamId"] = json!(sid);
            }

            let receipt = json!({
                "reference": reference,
                "callRef": call_ref,
                "argsDigest": args_digest,
                "metadata": metadata,
                "indexEntry": index_entry,
                "evidenceId": format!("ev-{}", uuid::Uuid::new_v4()),
                "grantAudit": {
                    "grantId": grant_id,
                    "toolCallId": source.tool_call_id,
                },
            });

            let obj_hash = Self::put_object(&conn, &body)?;
            if predecessor.is_some() {
                let updated = conn
                    .execute(
                        "UPDATE results SET head = ?1 WHERE id = ?2 AND owner = ?3",
                        params![content_version, result_id, owner_str],
                    )
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                if updated != 1 {
                    return Err(ProjectError::code("version_conflict"));
                }
            } else {
                conn.execute(
                    "INSERT INTO results(id, owner, head) VALUES(?1, ?2, ?3)",
                    params![result_id, owner_str, content_version],
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            }

            conn.execute(
                "INSERT INTO versions(id, version, owner, object, metadata, availability)
                 VALUES(?1, ?2, ?3, ?4, ?5, 'available')",
                params![
                    result_id,
                    content_version,
                    owner_str,
                    obj_hash,
                    encode_canonical(&metadata)?,
                ],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;

            conn.execute(
                "INSERT INTO operations(id, owner, conversation, toolCallId, argsDigest, phase, receipt)
                 VALUES(?1, ?2, ?3, ?4, ?5, 'index_pending', ?6)",
                params![
                    op_id,
                    owner_str,
                    source.conversation_id,
                    source.tool_call_id,
                    args_digest,
                    encode_canonical(&receipt)?,
                ],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;

            Self::enforce_budgets(&conn)?;
            let mut out = receipt;
            out["publicationStatus"] = json!("index_pending");
            Ok(out)
        })();

        match tx_res {
            Ok(val) => {
                conn.execute_batch("COMMIT;")
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                Ok(val)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(err)
            }
        }
    }

    pub fn mark_indexed(
        &self,
        call_ref: &Value,
        actual_index_record: &Value,
    ) -> Result<Value, ProjectError> {
        let owner: InteractiveOwner = serde_json::from_value(call_ref["owner"].clone())
            .map_err(|_| ProjectError::code("interactive_call_invalid"))?;
        Self::validate_owner(&owner)?;
        let conv_id = call_ref["conversationId"]
            .as_str()
            .filter(|s| interactive_token(s))
            .ok_or_else(|| ProjectError::code("interactive_call_invalid"))?;
        let call_id = call_ref["toolCallId"]
            .as_str()
            .filter(|s| interactive_token(s))
            .ok_or_else(|| ProjectError::code("interactive_call_invalid"))?;
        let op_id = Self::operation_key(&owner, conv_id, call_id)?;

        let conn = self.open_rw(&owner.workspace_id)?;
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|_| ProjectError::code("interactive_storage_unavailable"))?;

        let res: Result<Value, ProjectError> = (|| {
            let row: Option<(String, String)> = conn
                .query_row(
                    "SELECT phase, receipt FROM operations WHERE id = ?1",
                    params![op_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let Some((phase, raw)) = row else {
                return Err(ProjectError::code("publication_unknown"));
            };
            let mut saved: Value = serde_json::from_str(&raw)
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            if saved["unchanged"] == true || phase == "published" {
                saved["publicationStatus"] = json!("published");
                return Ok(saved);
            }
            let expected = &saved["indexEntry"];
            let fields_match = [
                "evidenceRef",
                "planId",
                "conversationId",
                "toolCallId",
                "capabilityId",
                "toolName",
                "createdAt",
            ]
            .iter()
            .all(|f| actual_index_record[*f] == expected[*f]);
            let stream_match = expected
                .get("streamId")
                .and_then(Value::as_str)
                .is_none_or(|s| actual_index_record["streamId"].as_str() == Some(s));
            let art_ref = saved["metadata"]["artifactRef"].as_str().unwrap_or("");
            let has_art_ref = actual_index_record["artifactRefs"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(art_ref)));
            let spec_hash = expected["userArtifacts"][0]["specHash"]
                .as_str()
                .unwrap_or("");
            let expected_ref = &saved["reference"];
            let has_user_art = actual_index_record["userArtifacts"]
                .as_array()
                .is_some_and(|a| {
                    a.iter().any(|u| {
                        u["kind"] == "interactive"
                            && u["ref"].as_str() == Some(art_ref)
                            && canonical_eq(&u["reference"], expected_ref)
                            && u["specHash"].as_str() == Some(spec_hash)
                    })
                });
            if !fields_match || !stream_match || !has_art_ref || !has_user_art {
                return Err(ProjectError::code("publication_index_conflict"));
            }

            let reference: InteractiveResultReference =
                serde_json::from_value(saved["reference"].clone())
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let _ = Self::load_version_inner(&conn, &reference, true, false)?;

            conn.execute(
                "UPDATE operations SET phase = 'published' WHERE id = ?1",
                params![op_id],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            saved["publicationStatus"] = json!("published");
            Ok(saved)
        })();

        match res {
            Ok(v) => {
                conn.execute_batch("COMMIT;")
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// Append any `index_pending` interactive result `indexEntry` records into
    /// `goal-plans/evidence-index.jsonl` and mark their operations `published`.
    pub fn reconcile_pending(&self, owner: &InteractiveOwner) -> Result<Vec<Value>, ProjectError> {
        Self::validate_owner(owner)?;
        let Some(conn) = self.open_ro(&owner.workspace_id)? else {
            return Ok(Vec::new());
        };
        let owner_str = encode_canonical(&serde_json::to_value(owner).unwrap())?;
        let mut stmt = conn
            .prepare(
                "SELECT receipt FROM operations WHERE owner = ?1 AND phase = 'index_pending' ORDER BY rowid LIMIT 32",
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let rows: Vec<String> = stmt
            .query_map(params![owner_str], |r| r.get::<_, String>(0))
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        drop(conn);

        if rows.is_empty() {
            return Ok(Vec::new());
        }

        let evidence_file = self.data_home.join("goal-plans/evidence-index.jsonl");
        if let Some(dir) = evidence_file.parent() {
            fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let evidence_store = EvidenceIndexStore::new(&self.data_home);
        let mut reconciled = Vec::new();

        for raw in rows {
            let receipt: Value = serde_json::from_str(&raw)
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let entry = &receipt["indexEntry"];
            let ev_ref = entry["evidenceRef"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ProjectError::code("interactive_storage_corrupt"))?
                .to_owned();

            // Check if already indexed; otherwise append with DirectoryLock
            let existing = evidence_store
                .find(std::slice::from_ref(&ev_ref), None)
                .unwrap_or_default();
            let actual = if let Some(first) = existing.into_iter().next() {
                first
            } else {
                let _lock = DirectoryLock::acquire(&evidence_file, LOCK_TIMEOUT, None)?;
                let mut line = serde_json::to_string(entry)
                    .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
                line.push('\n');
                let mut f = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&evidence_file)
                    .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
                f.write_all(line.as_bytes())
                    .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
                f.sync_all()
                    .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
                drop(_lock);
                evidence_store
                    .find(std::slice::from_ref(&ev_ref), None)
                    .map_err(|_| ProjectError::code("publication_index_pending"))?
                    .into_iter()
                    .next()
                    .ok_or_else(|| ProjectError::code("publication_index_pending"))?
            };

            let indexed = self.mark_indexed(&receipt["callRef"], &actual)?;
            reconciled.push(indexed);
        }
        Ok(reconciled)
    }

    fn load_version_inner(
        conn: &Connection,
        reference: &InteractiveResultReference,
        allow_pending: bool,
        allow_cleaned: bool,
    ) -> Result<(Value, Value, String), ProjectError> {
        if !reference.is_valid() {
            return Err(ProjectError::code("interactive_reference_invalid"));
        }
        let owner_str = encode_canonical(&serde_json::to_value(&reference.owner).unwrap())?;
        let row: Option<(String, String, String, String)> = conn
            .query_row(
                "SELECT owner, object, metadata, availability FROM versions WHERE id = ?1 AND version = ?2",
                params![reference.result_id, reference.content_version],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let Some((row_owner, obj_hash, meta_raw, avail)) = row else {
            return Err(ProjectError::code("interactive_result_unavailable"));
        };
        if row_owner != owner_str {
            return Err(ProjectError::code("interactive_scope_denied"));
        }
        if avail == "cleaned" && !allow_cleaned {
            return Err(ProjectError::code("interactive_content_cleaned"));
        }
        if !matches!(avail.as_str(), "available" | "cleaned") {
            return Err(ProjectError::code("interactive_storage_corrupt"));
        }
        let metadata: Value = serde_json::from_str(&meta_raw)
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        if !canonical_eq(&metadata["reference"], &json!(reference)) {
            return Err(ProjectError::code("interactive_storage_corrupt"));
        }
        let op_id = metadata["operationId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("interactive_storage_corrupt"))?;
        let phase: Option<String> = conn
            .query_row(
                "SELECT phase FROM operations WHERE id = ?1",
                params![op_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let phase = phase.ok_or_else(|| ProjectError::code("publication_unknown"))?;
        if !allow_pending && phase != "published" {
            return Err(ProjectError::code(if phase == "index_pending" {
                "publication_index_pending"
            } else {
                "publication_unknown"
            }));
        }
        if avail == "cleaned" {
            return Ok((metadata, Value::Null, phase));
        }
        let body = Self::read_object(conn, &obj_hash)?;
        let prov = body["provenance"]
            .as_array()
            .ok_or_else(|| ProjectError::code("interactive_content_corrupt"))?;
        let level = body["dataLevel"]
            .as_str()
            .ok_or_else(|| ProjectError::code("interactive_content_corrupt"))?;
        if content_digest(&body["content"], prov, level)? != reference.content_version
            || metadata["dataLevel"].as_str() != Some(level)
        {
            return Err(ProjectError::code("interactive_content_corrupt"));
        }
        Ok((metadata, body, phase))
    }

    pub fn get_version(
        &self,
        reference: &InteractiveResultReference,
        allow_pending: bool,
    ) -> Result<Value, ProjectError> {
        Self::validate_owner(&reference.owner)?;
        let Some(conn) = self.open_ro(&reference.owner.workspace_id)? else {
            return Err(ProjectError::code("interactive_result_unavailable"));
        };
        let (metadata, body, phase) =
            Self::load_version_inner(&conn, reference, allow_pending, false)?;
        Ok(json!({
            "reference": metadata["reference"],
            "source": metadata["source"],
            "predecessor": metadata["predecessor"],
            "evidenceRef": metadata["evidenceRef"],
            "artifactRef": metadata["artifactRef"],
            "dataLevel": metadata["dataLevel"],
            "createdAt": metadata["createdAt"],
            "operationId": metadata["operationId"],
            "content": body["content"],
            "provenance": body["provenance"],
            "publicationStatus": phase,
        }))
    }

    pub fn get_operation(
        &self,
        owner: &InteractiveOwner,
        conversation_id: &str,
        tool_call_id: &str,
    ) -> Result<Option<Value>, ProjectError> {
        Self::validate_owner(owner)?;
        if !interactive_token(conversation_id) || !interactive_token(tool_call_id) {
            return Err(ProjectError::code("interactive_call_invalid"));
        }
        let Some(conn) = self.open_ro(&owner.workspace_id)? else {
            return Ok(None);
        };
        let op_id = Self::operation_key(owner, conversation_id, tool_call_id)?;
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT argsDigest, phase, receipt FROM operations WHERE id = ?1",
                params![op_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let Some((args_digest, phase, raw)) = row else {
            return Ok(None);
        };
        let mut receipt: Value = serde_json::from_str(&raw)
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        receipt["publicationStatus"] = json!(phase);
        receipt["argsDigest"] = json!(args_digest);
        Ok(Some(receipt))
    }

    pub fn list_for_owner(&self, owner: &InteractiveOwner) -> Result<Vec<Value>, ProjectError> {
        Self::validate_owner(owner)?;
        let Some(conn) = self.open_ro(&owner.workspace_id)? else {
            return Ok(Vec::new());
        };
        let owner_str = encode_canonical(&serde_json::to_value(owner).unwrap())?;
        let mut stmt = conn
            .prepare("SELECT id, head FROM results WHERE owner = ?1")
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let heads: Vec<(String, String)> = stmt
            .query_map(params![owner_str], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);

        let mut items = Vec::new();
        for (result_id, head) in heads {
            let reference = InteractiveResultReference {
                owner: owner.clone(),
                result_id,
                content_version: head,
            };
            let Some((metadata, body, phase)) =
                Self::load_version_inner(&conn, &reference, false, true).ok()
            else {
                continue;
            };
            if phase != "published" {
                continue;
            }
            let title = body["content"]["title"].as_str().unwrap_or("").to_owned();
            let locator = reference.locator();
            items.push(json!({
                "ref": locator,
                "reference": reference,
                "title": title,
                "dataLevel": metadata["dataLevel"],
                "createdAt": metadata["createdAt"],
                "cleaned": body.is_null(),
            }));
        }
        items.sort_by(|a, b| {
            b["createdAt"]
                .as_str()
                .unwrap_or("")
                .cmp(a["createdAt"].as_str().unwrap_or(""))
        });
        Ok(items)
    }

    /// Capture and redact a governed tool execution observation into `objects` + `materials`
    /// (`packages/runtime-node/src/interactive-results/capture.mjs` & `store.mjs#recordMaterial`).
    pub fn capture_tool_observation(
        &self,
        owner: &InteractiveOwner,
        conversation_id: &str,
        tool_call_id: &str,
        payload: &Value,
        data_level: &str,
        observed_at: &str,
    ) -> Result<Value, ProjectError> {
        Self::validate_owner(owner)?;
        if !interactive_token(conversation_id)
            || !interactive_token(tool_call_id)
            || data_level_rank(data_level).is_none()
        {
            return Err(ProjectError::code("material_snapshot_unavailable"));
        }
        let (sanitized, redacted) = redact_value(payload);
        let value = json!({
            "format": "peer-tool-observation-1",
            "payload": sanitized,
        });
        let content_version = json_digest(&value)?;
        let source = json!({
            "kind": "tool-result",
            "conversationId": conversation_id,
            "toolCallId": tool_call_id,
            "expectedContentVersion": content_version,
        });
        let mat_id = json_digest(&json!(["tool-result", conversation_id, tool_call_id,]))?;
        let owner_val = serde_json::to_value(owner).unwrap();
        let owner_str = encode_canonical(&owner_val)?;
        let metadata = json!({
            "owner": owner,
            "source": source,
            "contentVersion": content_version,
            "dataLevel": data_level,
            "observedAt": observed_at,
            "truncated": false,
            "redacted": redacted,
            "evidenceRefs": [format!("tool-result://{tool_call_id}")],
        });

        let conn = self.open_rw(&owner.workspace_id)?;
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|_| ProjectError::code("interactive_storage_unavailable"))?;
        let tx_res: Result<(), ProjectError> = (|| {
            Self::remember_privacy(&conn, &owner_str, data_level)?;
            let obj_hash = Self::put_object(&conn, &value)?;
            let existing: Option<(String, String)> = conn
                .query_row(
                    "SELECT owner, object FROM materials WHERE id = ?1",
                    params![mat_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            if let Some((prev_owner, prev_obj)) = existing {
                if prev_owner != owner_str || prev_obj != obj_hash {
                    return Err(ProjectError::code("material_identity_conflict"));
                }
            } else {
                conn.execute(
                    "INSERT INTO materials(id, owner, object, metadata) VALUES(?1, ?2, ?3, ?4)",
                    params![mat_id, owner_str, obj_hash, encode_canonical(&metadata)?],
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            }
            Self::enforce_budgets(&conn)?;
            Ok(())
        })();
        match tx_res {
            Ok(()) => conn
                .execute_batch("COMMIT;")
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                return Err(e);
            }
        }
        Ok(json!({
            "source": source,
            "format": "peer-tool-observation-1",
            "selectorRoots": ["payload"],
            "dataLevel": data_level,
            "truncated": false,
            "redacted": redacted,
        }))
    }

    pub fn read_material(
        &self,
        owner: &InteractiveOwner,
        conversation_id: &str,
        tool_call_id: &str,
        expected_content_version: &str,
    ) -> Result<Option<Value>, ProjectError> {
        Self::validate_owner(owner)?;
        if !interactive_token(conversation_id)
            || !interactive_token(tool_call_id)
            || !interactive_digest(expected_content_version)
        {
            return Ok(None);
        }
        let Some(conn) = self.open_ro(&owner.workspace_id)? else {
            return Ok(None);
        };
        let mat_id = json_digest(&json!(["tool-result", conversation_id, tool_call_id]))?;
        let owner_str = encode_canonical(&serde_json::to_value(owner).unwrap())?;
        let row: Option<(String, String, String)> = conn
            .query_row(
                "SELECT owner, object, metadata FROM materials WHERE id = ?1",
                params![mat_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        let Some((row_owner, obj_hash, meta_raw)) = row else {
            return Ok(None);
        };
        if row_owner != owner_str {
            return Err(ProjectError::code("interactive_scope_denied"));
        }
        let mut metadata: Value = serde_json::from_str(&meta_raw)
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
        if metadata["contentVersion"].as_str() != Some(expected_content_version) {
            return Err(ProjectError::code("material_version_mismatch"));
        }
        let value = Self::read_object(&conn, &obj_hash)?;
        metadata["value"] = value;
        metadata["canonical"] = json!(true);
        metadata["available"] = json!(true);
        Ok(Some(metadata))
    }

    /// Governed read inspection (`local.interactive.inspect` / `provider.mjs`).
    /// Enforces role ceiling: `project_agent` may only inspect `metadata` or `text`.
    pub fn inspect_for_role(
        &self,
        role: &str,
        owner: &InteractiveOwner,
        request: &Value,
    ) -> Result<Value, ProjectError> {
        Self::validate_owner(owner)?;
        let view = request["view"]
            .as_str()
            .filter(|v| matches!(*v, "metadata" | "text" | "program" | "data" | "evaluate"))
            .ok_or_else(|| ProjectError::code("interactive_inspect_invalid"))?;
        if !matches!(
            role,
            "project_agent" | "session_worker" | "verifier" | "visual_verifier"
        ) || (role == "project_agent" && !matches!(view, "metadata" | "text"))
        {
            return Err(ProjectError::code("interactive_role_denied"));
        }

        let target = &request["target"];
        match target["kind"].as_str() {
            Some("publication") => {
                if view != "metadata" {
                    return Err(ProjectError::code("interactive_inspect_invalid"));
                }
                let call_ref = &target["reference"];
                let target_owner: InteractiveOwner =
                    serde_json::from_value(call_ref["owner"].clone())
                        .map_err(|_| ProjectError::code("interactive_inspect_invalid"))?;
                if target_owner != *owner {
                    return Err(ProjectError::code("interactive_scope_denied"));
                }
                let conv_id = call_ref["conversationId"]
                    .as_str()
                    .filter(|s| interactive_token(s))
                    .ok_or_else(|| ProjectError::code("interactive_inspect_invalid"))?;
                let call_id = call_ref["toolCallId"]
                    .as_str()
                    .filter(|s| interactive_token(s))
                    .ok_or_else(|| ProjectError::code("interactive_inspect_invalid"))?;
                let receipt = self
                    .get_operation(owner, conv_id, call_id)?
                    .ok_or_else(|| ProjectError::code("publication_unknown"))?;
                let status = receipt["publicationStatus"].as_str().unwrap_or("unknown");
                Ok(json!({
                    "kind": "interactive_publication_status",
                    "callRef": call_ref,
                    "publicationStatus": status,
                    "reference": receipt["reference"],
                    "effectCommitted": true,
                }))
            }
            Some("result") => {
                let reference: InteractiveResultReference =
                    serde_json::from_value(target["reference"].clone())
                        .map_err(|_| ProjectError::code("interactive_inspect_invalid"))?;
                if !reference.is_valid() {
                    return Err(ProjectError::code("interactive_reference_invalid"));
                }
                if reference.owner != *owner {
                    return Err(ProjectError::code("interactive_scope_denied"));
                }
                let fixed = self.get_version(&reference, false)?;
                let content = &fixed["content"];
                let offset = request["offset"].as_u64();
                let limit = request["limit"].as_u64();
                let sources: Vec<Value> = fixed["provenance"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned()
                    .collect();
                let mut out = json!({
                    "kind": "interactive_inspection",
                    "reference": fixed["reference"],
                    "specHash": content["specHash"],
                    "view": view,
                    "dataLevel": fixed["dataLevel"],
                    "source": fixed["source"],
                    "evidenceRef": fixed["evidenceRef"],
                });
                match view {
                    "metadata" => {
                        out["title"] = content["title"].clone();
                        out["publicationStatus"] = json!("published");
                        out["sources"] = json!(sources);
                        if !fixed["predecessor"].is_null() {
                            out["predecessor"] = fixed["predecessor"].clone();
                        }
                    }
                    "text" => {
                        out["classification"] = json!("model-text-fallback");
                        let paged = page_text(
                            content["textFallback"].as_str().unwrap_or(""),
                            offset,
                            limit,
                        )?;
                        for (k, v) in paged.as_object().into_iter().flatten() {
                            out[k] = v.clone();
                        }
                    }
                    "program" => {
                        out["classification"] = json!("model-program");
                        let paged =
                            page_text(content["program"].as_str().unwrap_or(""), offset, limit)?;
                        for (k, v) in paged.as_object().into_iter().flatten() {
                            out[k] = v.clone();
                        }
                    }
                    "data" => {
                        let binding_id = request["bindingId"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or_else(|| ProjectError::code("interactive_inspect_invalid"))?;
                        let val = content["bindings"]
                            .get(binding_id)
                            .ok_or_else(|| ProjectError::code("interactive_binding_unavailable"))?;
                        let selected = select_data(val, request.get("selector"))?;
                        let encoded = encode_canonical(&selected)?;
                        out["bindingId"] = json!(binding_id);
                        out["encoding"] = json!("canonical-json");
                        out["range"] = request
                            .get("selector")
                            .filter(|v| v.is_object())
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        let paged = page_text(&encoded, offset, limit)?;
                        for (k, v) in paged.as_object().into_iter().flatten() {
                            out[k] = v.clone();
                        }
                    }
                    "evaluate" => {
                        let text_summary = format!(
                            "{}\n{}",
                            content["title"].as_str().unwrap_or(""),
                            content["textFallback"].as_str().unwrap_or("")
                        );
                        out["classification"] = json!("host-derived");
                        let paged = page_text(&text_summary, offset, limit)?;
                        for (k, v) in paged.as_object().into_iter().flatten() {
                            out[k] = v.clone();
                        }
                        out["computationTruncated"] = out["truncated"].clone();
                    }
                    _ => return Err(ProjectError::code("interactive_inspect_invalid")),
                }
                Ok(out)
            }
            _ => Err(ProjectError::code("interactive_inspect_invalid")),
        }
    }

    /// Clean up versions & large object blobs for `reference` and commit an immutable 9-field
    /// tombstone receipt verified by `peer_store::read_interactive_cleanup_receipt` and
    /// `crates/peer-store/src/interactive_result/local/tombstone.rs`.
    pub fn cleanup_result(
        &self,
        reference: &InteractiveResultReference,
        request_id: &str,
        expected_digest: &str,
        cleaned_at: &str,
        holds_lease: bool,
    ) -> Result<Value, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if !reference.is_valid() {
            return Err(ProjectError::code("interactive_reference_invalid"));
        }
        if !interactive_token(request_id)
            || !interactive_digest(expected_digest)
            || OffsetDateTime::parse(cleaned_at, &Rfc3339).is_err()
        {
            return Err(ProjectError::code("interactive_cleanup_invalid"));
        }

        let owner_val = serde_json::to_value(&reference.owner).unwrap();
        let owner_str = encode_canonical(&owner_val)?;
        let Some(conn) = self.open_ro(&reference.owner.workspace_id)? else {
            return Err(ProjectError::code("interactive_result_unavailable"));
        };
        drop(conn);

        let conn = self.open_rw(&reference.owner.workspace_id)?;
        conn.execute_batch("BEGIN IMMEDIATE;")
            .map_err(|_| ProjectError::code("interactive_storage_unavailable"))?;

        let tx_res: Result<Value, ProjectError> = (|| {
            // Replay guard on existing tombstone receipt
            let existing_raw: Option<String> = conn
                .query_row(
                    "SELECT body FROM presentation WHERE category = ?1 AND id = ?2 AND owner = ?3",
                    params![CLEANUP_CATEGORY, reference.result_id, owner_str],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|_| ProjectError::code("interactive_cleanup_corrupt"))?;
            if let Some(raw) = existing_raw {
                let saved: Value = serde_json::from_str(&raw)
                    .map_err(|_| ProjectError::code("interactive_cleanup_corrupt"))?;
                if !canonical_eq(&saved["reference"], &json!(reference))
                    || saved["requestId"].as_str() != Some(request_id)
                    || saved["expectedDigest"].as_str() != Some(expected_digest)
                {
                    return Err(ProjectError::code("interactive_cleanup_parameter_conflict"));
                }
                return Ok(saved);
            }

            let head_row: Option<(String, String)> = conn
                .query_row(
                    "SELECT owner, head FROM results WHERE id = ?1",
                    params![reference.result_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let Some((head_owner, head_ver)) = head_row else {
                return Err(ProjectError::code("interactive_result_unavailable"));
            };
            if head_owner != owner_str {
                return Err(ProjectError::code("interactive_scope_denied"));
            }
            if head_ver != reference.content_version {
                return Err(ProjectError::code("version_conflict"));
            }

            let mut stmt = conn
                .prepare(
                    "SELECT version, object, metadata, availability FROM versions WHERE id = ?1 ORDER BY version",
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let ver_rows: Vec<(String, String, String, String)> = stmt
                .query_map(params![reference.result_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                })
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?
                .filter_map(Result::ok)
                .collect();
            drop(stmt);
            if ver_rows.is_empty() {
                return Err(ProjectError::code("interactive_result_unavailable"));
            }

            let tombstone_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM presentation WHERE category = ?1 AND owner = ?2",
                    params![CLEANUP_CATEGORY, owner_str],
                    |r| r.get(0),
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            if tombstone_count as usize >= INTERACTIVE_TOMBSTONE_LIMIT {
                return Err(ProjectError::code("interactive_cleanup_limit"));
            }

            let mut summaries = Vec::with_capacity(ver_rows.len());
            let mut objects = BTreeSet::new();
            for (ver_str, obj_hash, meta_raw, avail) in &ver_rows {
                if avail == "cleaned" {
                    return Err(ProjectError::code("interactive_cleanup_corrupt"));
                }
                let meta: Value = serde_json::from_str(meta_raw)
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                let op_id = meta["operationId"]
                    .as_str()
                    .ok_or_else(|| ProjectError::code("interactive_storage_corrupt"))?;
                let phase: Option<String> = conn
                    .query_row(
                        "SELECT phase FROM operations WHERE id = ?1",
                        params![op_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                if phase.as_deref() != Some("published") {
                    return Err(ProjectError::code("interactive_cleanup_blocked"));
                }
                let body = Self::read_object(&conn, obj_hash)?;
                let title = body["content"]["title"].as_str().unwrap_or("").to_owned();
                let fallback = body["content"]["textFallback"].as_str().unwrap_or("");
                let (clipped_fb, truncated) = truncate_utf16_units(fallback, 256);
                let v_ref = InteractiveResultReference {
                    owner: reference.owner.clone(),
                    result_id: reference.result_id.clone(),
                    content_version: ver_str.clone(),
                };
                summaries.push(json!({
                    "reference": v_ref,
                    "source": meta["source"],
                    "dataLevel": meta["dataLevel"],
                    "title": title,
                    "textFallback": clipped_fb,
                    "truncated": truncated,
                }));
                objects.insert(obj_hash.clone());
            }

            let state_rows: usize = conn
                .execute(
                    "DELETE FROM states WHERE id = ?1",
                    params![reference.result_id],
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            let save_rows: usize = conn
                .execute(
                    "DELETE FROM saves WHERE id = ?1",
                    params![reference.result_id],
                )
                .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;

            let mut removable = Vec::new();
            let mut object_bytes_removed: i64 = 0;
            for hash in objects {
                let in_other_ver: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM versions WHERE object = ?1 AND id <> ?2 AND availability = 'available' LIMIT 1",
                        params![hash, reference.result_id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                let in_mat: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM materials WHERE object = ?1 LIMIT 1",
                        params![hash],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                if in_other_ver.is_none() && in_mat.is_none() {
                    let bytes: i64 = conn
                        .query_row(
                            "SELECT bytes FROM objects WHERE hash = ?1",
                            params![hash],
                            |r| r.get(0),
                        )
                        .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                    object_bytes_removed += bytes;
                    removable.push(hash);
                }
            }

            let body = json!({
                "schemaVersion": 1,
                "reference": reference,
                "requestId": request_id,
                "expectedDigest": expected_digest,
                "cleanedAt": cleaned_at,
                "versions": summaries,
                "stateRowsRemoved": state_rows,
                "saveRowsRemoved": save_rows,
                "objectBytesRemoved": object_bytes_removed,
            });
            let receipt_digest = json_digest(&body)?;
            let mut full = body;
            full["receiptDigest"] = json!(receipt_digest);

            conn.execute(
                "UPDATE versions SET availability = 'cleaned' WHERE id = ?1 AND owner = ?2",
                params![reference.result_id, owner_str],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            conn.execute(
                "INSERT INTO presentation(category, id, owner, body) VALUES(?1, ?2, ?3, ?4)",
                params![
                    CLEANUP_CATEGORY,
                    reference.result_id,
                    owner_str,
                    encode_canonical(&full)?,
                ],
            )
            .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            for hash in removable {
                conn.execute("DELETE FROM objects WHERE hash = ?1", params![hash])
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
            }
            Self::enforce_budgets(&conn)?;
            Ok(full)
        })();

        match tx_res {
            Ok(v) => {
                conn.execute_batch("COMMIT;")
                    .map_err(|_| ProjectError::code("interactive_storage_corrupt"))?;
                Ok(v)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }
}

pub fn build_cleanup_expected_digest(
    reference: &InteractiveResultReference,
    summary_hint: &str,
) -> Result<String, ProjectError> {
    json_digest(&json!({ "reference": reference, "hint": summary_hint }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BotProfileStore, CreateBotProfile};
    use peer_protocol::interactive_result::InteractiveAvailability;
    use peer_store::{
        InteractiveCleanupRequest, read_interactive_cleanup_receipt, read_interactive_result,
    };
    use tempfile::tempdir;

    #[test]
    fn commit_reconcile_inspect_and_cleanup_roundtrip_with_peer_store_reader() {
        let dir = tempdir().unwrap();
        let profiles = BotProfileStore::new(dir.path());
        profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-ir-1",
                display_name: "Result Bot",
                agent_conversation_id: "conv-bot-1",
                managed: true,
                avatar_salt: "ws-ir-1",
            })
            .unwrap();

        let store = InteractiveResultStore::new(dir.path());
        let owner = InteractiveOwner {
            workspace_id: "ws-ir-1".into(),
            conversation_id: "conv-bot-1".into(),
        };
        let obs = store
            .capture_tool_observation(
                &owner,
                "conv-worker-1",
                "call-obs-1",
                &json!({"token": "sk-live-secret1234567890abcdef", "rows": [{"name": "Alpha", "score": 42}]}),
                "D2_sensitive",
                "2026-11-21T00:00:00.000Z",
            )
            .unwrap();
        assert_eq!(obs["redacted"], true);
        let mat_ver = obs["source"]["expectedContentVersion"].as_str().unwrap();
        let mat = store
            .read_material(&owner, "conv-worker-1", "call-obs-1", mat_ver)
            .unwrap()
            .unwrap();
        assert_eq!(mat["value"]["payload"]["token"], "[REDACTED]");

        let pub_res = store
            .commit_publication(
                &PublishInteractiveRequest {
                    owner: owner.clone(),
                    source: InteractiveResultSource {
                        conversation_id: "conv-worker-1".into(),
                        plan_id: "plan-1".into(),
                        session_id: "sess-1".into(),
                        tool_call_id: "call-pub-1".into(),
                        execution_epoch: Some("epoch-1".into()),
                    },
                    publication_kind: "create".into(),
                    base: None,
                    title: "Benchmark Table".into(),
                    text_fallback: "Row 1: Alpha = 42".into(),
                    program: "root = Table(\"Scores\", [], @Data(\"rows\"), \"name\")".into(),
                    bindings: json!({"rows": [{"name": "Alpha", "score": 42}]}),
                    provenance: vec![],
                    data_level: "D2_sensitive".into(),
                    grant_id: "grant-1".into(),
                    stream_id: None,
                },
                true,
            )
            .unwrap();
        assert_eq!(pub_res["publicationStatus"], "index_pending");

        let reconciled = store.reconcile_pending(&owner).unwrap();
        assert_eq!(reconciled.len(), 1);
        assert_eq!(reconciled[0]["publicationStatus"], "published");

        let ref_obj: InteractiveResultReference =
            serde_json::from_value(pub_res["reference"].clone()).unwrap();
        let locator = ref_obj.locator();
        assert_eq!(
            task_result_references(&[locator.clone(), locator.clone(), "other".into()]),
            vec![locator]
        );

        // peer-store read_interactive_result must validate and read it as Available
        let summary = read_interactive_result(dir.path(), &ref_obj).unwrap();
        assert_eq!(summary.availability, InteractiveAvailability::Available);
        assert_eq!(summary.title, "Benchmark Table");
        assert_eq!(summary.text_fallback.text, "Row 1: Alpha = 42");

        // Role enforcement: project_agent allowed metadata & text, denied program/data/evaluate
        let denied = store.inspect_for_role(
            "project_agent",
            &owner,
            &json!({"target": {"kind": "result", "reference": ref_obj}, "view": "program"}),
        );
        assert_eq!(denied.unwrap_err().code, "interactive_role_denied");

        let ok_text = store
            .inspect_for_role(
                "project_agent",
                &owner,
                &json!({"target": {"kind": "result", "reference": ref_obj}, "view": "text"}),
            )
            .unwrap();
        assert_eq!(ok_text["text"], "Row 1: Alpha = 42");

        // Cleanup -> tombstone readable by peer-store
        let exp_digest = build_cleanup_expected_digest(&ref_obj, "clean-1").unwrap();
        let receipt = store
            .cleanup_result(
                &ref_obj,
                "req-clean-1",
                &exp_digest,
                "2026-11-21T01:00:00.000Z",
                true,
            )
            .unwrap();
        assert_eq!(receipt["schemaVersion"], 1);

        let cleaned_summary = read_interactive_result(dir.path(), &ref_obj).unwrap();
        assert_eq!(
            cleaned_summary.availability,
            InteractiveAvailability::Cleaned
        );

        let cleanup_req = InteractiveCleanupRequest::parse(
            json!({
                "op": "receipt",
                "kind": "result",
                "target": ref_obj,
                "requestId": "req-clean-1",
                "expectedDigest": exp_digest,
            })
            .to_string()
            .as_bytes(),
        )
        .unwrap();
        let verified_receipt = read_interactive_cleanup_receipt(dir.path(), &cleanup_req).unwrap();
        assert!(verified_receipt.is_some());
    }
}
