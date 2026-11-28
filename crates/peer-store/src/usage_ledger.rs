//! ADR25/131 recoverable billing sink. A billing log is never context authority.
use crate::{
    ConversationStore, DirectoryLock, StoreError, conversation_write::lock_index,
    durable_jsonl as log, files, valid_id,
};
use peer_protocol::{
    JsonDecodeError, JsonLimits, RuntimeTurnUsage, approval_args_digest as stable_json_digest,
    decode_json_bounded, javascript_json_string, javascript_trim,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

#[path = "usage_ledger_contract.generated.rs"]
mod contract;
use contract::{INTENT_BYTES, INTENT_FILE, LEDGER_RELATIVE, ROW_BYTES, SCHEMA_VERSION};
const SAFE: u64 = 9_007_199_254_740_991;
const AMOUNTS: [&str; 4] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
];
type Result<T> = std::result::Result<T, StoreError>;
fn invalid() -> StoreError {
    StoreError::UsageInvalid
}
fn integer(v: &Value) -> Result<u64> {
    if v.is_null() {
        return Ok(0);
    }
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= SAFE as f64)
        .map(|n| n as u64)
        .ok_or_else(invalid)
}
fn add(a: &Value, b: &Value) -> Result<Value> {
    Ok(json!(
        integer(a)?
            .checked_add(integer(b)?)
            .filter(|v| *v <= SAFE)
            .ok_or(StoreError::UsageInvalid)?
    ))
}
fn total(v: &Value) -> Result<Value> {
    let mut sum = json!(0);
    for key in AMOUNTS {
        sum = add(&sum, &v[key])?;
    }
    Ok(sum)
}
fn text(v: &Value) -> Value {
    v.as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty())
        .map(|s| json!(s))
        .unwrap_or(Value::Null)
}
fn encode(v: &Value, max: usize) -> Result<Vec<u8>> {
    let bytes = javascript_json_string(v)
        .map_err(|_| StoreError::UsageLimit)?
        .into_bytes();
    decode(&bytes, max)?;
    Ok(bytes)
}
fn decode(bytes: &[u8], max: usize) -> Result<Value> {
    if bytes.len() > max {
        return Err(StoreError::UsageLimit);
    }
    decode_json_bounded(
        bytes,
        JsonLimits {
            bytes: max,
            depth: 64,
            nodes: 65536,
            string_bytes: max,
        },
    )
    .map(|v| v.value)
    .map_err(|error| match error {
        JsonDecodeError::LimitExceeded => StoreError::UsageLimit,
        JsonDecodeError::InvalidJson => StoreError::UsageInvalid,
    })
}
fn equal(a: &Value, b: &Value) -> Result<bool> {
    Ok(stable_json_digest(a).map_err(|_| invalid())?
        == stable_json_digest(b).map_err(|_| invalid())?)
}
fn counters(meta: &Value) -> Value {
    json!({"lifetimeUsage":meta.get("lifetimeUsage").unwrap_or(&Value::Null),"runtimeTurnCount":meta.get("runtimeTurnCount").unwrap_or(&Value::Null)})
}
fn lifetime(meta: &Value) -> Result<Value> {
    let mut v = meta["lifetimeUsage"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    v.insert("usageScope".into(), json!("conversation_lifetime"));
    v.insert(
        "runtimeTurnCount".into(),
        json!(integer(&meta["runtimeTurnCount"])?),
    );
    for key in AMOUNTS {
        v.insert(key.into(), json!(integer(&meta["lifetimeUsage"][key])?));
    }
    let mut result = Value::Object(v);
    result["totalTokens"] = total(&result)?;
    Ok(result)
}
fn row(id: &str, usage: &RuntimeTurnUsage, attribution: &Value) -> Result<Value> {
    let provider = text(&attribution["modelProviderId"]);
    let mut row = json!({"id":text(&attribution["id"]),"at":text(&attribution["at"]),"conversationId":id,
        "streamId":text(&attribution["streamId"]),"modelProviderId":provider,"groupId":text(&attribution["groupId"]),
        "model":text(&attribution["model"]),"providerName":text(&attribution["providerName"]),"usageScope":"runtime_turn",
        "providerRequestCount":usage.provider_request_count,"inputTokens":usage.amounts.input_tokens,"outputTokens":usage.amounts.output_tokens,
        "cacheReadTokens":usage.amounts.cache_read_tokens,"cacheWriteTokens":usage.amounts.cache_write_tokens,
        "estimatedCostUsd":attribution.get("estimatedCostUsd").unwrap_or(&Value::Null),"pricingSource":text(&attribution["pricingSource"])});
    if row["id"].is_null() {
        row["id"] = json!(format!("runtime_turn_{}", uuid::Uuid::new_v4()));
    }
    if row["at"].is_null() {
        row["at"] = json!(now()?);
    }
    if row["groupId"].is_null()
        && let Some((group, _)) = provider.as_str().and_then(|s| s.split_once("::"))
    {
        row["groupId"] = text(&json!(group));
    }
    for key in ["role", "workspaceId"] {
        let v = text(&attribution[key]);
        if !v.is_null() {
            row[key] = v;
        }
    }
    row["totalTokens"] = total(&row)?;
    validate_row(&row)?;
    Ok(row)
}
fn validate_row(row: &Value) -> Result<()> {
    if row["usageScope"] != "runtime_turn"
        || text(&row["id"]).is_null()
        || text(&row["conversationId"]).is_null()
        || integer(&row["providerRequestCount"])? == 0
        || !equal(&row["totalTokens"], &total(row)?)?
    {
        return Err(invalid());
    }
    if !row["estimatedCostUsd"].is_null()
        && row["estimatedCostUsd"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n < 0.0)
    {
        return Err(invalid());
    }
    encode(row, ROW_BYTES - 1)?;
    Ok(())
}
fn object_or_empty(v: &Value) -> Result<Value> {
    if v.is_null() {
        Ok(json!({}))
    } else if v.is_object() {
        Ok(v.clone())
    } else {
        Err(invalid())
    }
}
fn next(meta: &Value, row: &Value) -> Result<Value> {
    let mut usage = object_or_empty(&meta["lifetimeUsage"])?;
    let mut by_model = object_or_empty(&usage["byModel"])?;
    let key = row["modelProviderId"].as_str().unwrap_or("unknown");
    let mut entry = object_or_empty(&by_model[key])?;
    for field in AMOUNTS {
        entry[field] = add(&entry[field], &row[field])?;
        usage[field] = add(&usage[field], &row[field])?;
    }
    entry["totalTokens"] = total(&entry)?;
    entry["requestCount"] = add(&entry["requestCount"], &json!(1))?;
    entry["modelProviderId"] = json!(key);
    for field in ["model", "providerName"] {
        if !row[field].is_null() {
            entry[field] = row[field].clone();
        }
    }
    let cost = |v: &Value| -> Result<f64> {
        if v.is_null() {
            Ok(0.0)
        } else {
            v.as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .ok_or_else(invalid)
        }
    };
    let usd = cost(&entry["estimatedCostUsd"])? + cost(&row["estimatedCostUsd"])?;
    if !usd.is_finite() {
        return Err(invalid());
    }
    entry["estimatedCostUsd"] = json!(usd);
    by_model[key] = entry;
    usage["byModel"] = by_model;
    Ok(json!({"lifetimeUsage":usage,"runtimeTurnCount":add(&meta["runtimeTurnCount"],&json!(1))?}))
}
fn now() -> Result<String> {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| invalid())
}
fn fault(_transaction: &Path, _step: &str) -> Result<()> {
    #[cfg(feature = "test-fixtures")]
    if _transaction
        .parent()
        .and_then(Path::parent)
        .is_some_and(|home| home.join(".native-cli-fixture").is_file())
    {
        match std::env::var("PEER_NATIVE_USAGE_FAULT").ok().as_deref() {
            Some(value) if value == format!("interrupt:{_step}") => {
                return Err(StoreError::UsageCommitUncertain);
            }
            Some(value) if value == format!("crash:{_step}") => std::process::exit(77),
            Some(value) if value == format!("hold:{_step}") => {
                std::thread::sleep(Duration::from_secs(6))
            }
            _ => (),
        }
    }
    Ok(())
}
fn position(rows: &[Value], id: &str) -> Result<Option<usize>> {
    let matches = rows
        .iter()
        .enumerate()
        .filter(|(_, v)| v["id"] == id)
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        Err(StoreError::UsageConflict)
    } else {
        Ok(matches.first().copied())
    }
}
struct Scan {
    found: Option<Value>,
    length: u64,
    tail: Vec<u8>,
    last_complete: u64,
    sha256: String,
    prefix_sha256: String,
    version: Option<files::FileIdentity>,
}
fn scan(
    file: &Path,
    id: &str,
    turn: &str,
    prefix_bytes: u64,
    cancel: Option<&AtomicBool>,
) -> Result<Scan> {
    let mut s = Scan {
        found: None,
        length: 0,
        tail: Vec::new(),
        last_complete: 0,
        sha256: String::new(),
        prefix_sha256: String::new(),
        version: None,
    };
    let (mut hash, mut prefix) = (Sha256::new(), Sha256::new());
    if let Some((mut fd, before)) = files::open(file, u64::MAX)? {
        let mut block = [0u8; 65536];
        loop {
            log::check_cancel(cancel)?;
            let n = fd.read(&mut block).map_err(|_| StoreError::ReadFailed)?;
            if n == 0 {
                break;
            }
            hash.update(&block[..n]);
            prefix.update(&block[..(prefix_bytes.saturating_sub(s.length).min(n as u64) as usize)]);
            let mut start = 0;
            for i in 0..n {
                if block[i] == b'\n' {
                    if s.tail.len() + i - start > ROW_BYTES {
                        return Err(StoreError::UsageLimit);
                    }
                    s.tail.extend_from_slice(&block[start..i]);
                    if !s.tail.iter().all(u8::is_ascii_whitespace) {
                        let row = decode(&s.tail, ROW_BYTES)?;
                        if !row.is_object() {
                            return Err(invalid());
                        }
                        if row["id"] == turn && row["conversationId"] == id {
                            if s.found.is_some() {
                                return Err(StoreError::UsageConflict);
                            }
                            s.found = Some(row);
                        }
                    }
                    s.tail.clear();
                    start = i + 1;
                    s.last_complete = s.length + start as u64;
                }
            }
            if s.tail.len() + n - start > ROW_BYTES {
                return Err(StoreError::UsageLimit);
            }
            s.tail.extend_from_slice(&block[start..n]);
            s.length += n as u64;
        }
        if s.length != before.size || files::identity(file)?.as_ref() != Some(&before) {
            return Err(StoreError::UsageConflict);
        }
        s.version = Some(before);
    }
    s.sha256 = format!("{:x}", hash.finalize());
    s.prefix_sha256 = format!("{:x}", prefix.finalize());
    Ok(s)
}
fn recover(
    transaction: &Path,
    ledger: &Path,
    index_file: &Path,
    relative: &str,
    rows: &mut [Value],
    intent: &mut Value,
) -> Result<()> {
    let prefix = integer(&intent["prefixBytes"])?;
    if integer(&intent["schemaVersion"])? != SCHEMA_VERSION
        || intent["ledgerRelative"] != relative
        || !intent["prefixBytes"].is_number()
        || !intent["prefixSha256"].as_str().is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        || intent["ledgerRow"]["conversationId"] != intent["conversationId"]
    {
        return Err(invalid());
    }
    validate_row(&intent["ledgerRow"])?;
    let id = intent["conversationId"].as_str().ok_or_else(invalid)?;
    let pos = position(rows, id)?.ok_or(StoreError::UsageConflict)?;
    let current = counters(&rows[pos]);
    if !equal(&current, &intent["before"])? && !equal(&current, &intent["after"])? {
        return Err(StoreError::UsageConflict);
    }
    if !equal(
        &next(&intent["before"], &intent["ledgerRow"])?,
        &intent["after"],
    )? {
        return Err(invalid());
    }
    let s = scan(
        ledger,
        id,
        intent["ledgerRow"]["id"].as_str().ok_or_else(invalid)?,
        prefix,
        None,
    )?;
    if s.length < prefix || intent["prefixSha256"] != s.prefix_sha256 {
        return Err(StoreError::UsageConflict);
    }
    let line = intent["ledgerLine"]
        .as_str()
        .ok_or_else(invalid)?
        .as_bytes()
        .to_vec();
    if line.len() > ROW_BYTES
        || line.last() != Some(&b'\n')
        || line[..line.len() - 1].contains(&b'\n')
        || !equal(
            &decode(&line[..line.len() - 1], ROW_BYTES)?,
            &intent["ledgerRow"],
        )?
    {
        return Err(invalid());
    }
    if s.found
        .as_ref()
        .is_some_and(|v| !equal(v, &intent["ledgerRow"]).unwrap_or(false))
    {
        return Err(StoreError::UsageConflict);
    }
    if !s.tail.is_empty()
        && (s.found.is_some() || s.last_complete != prefix || !line.starts_with(&s.tail))
    {
        return Err(StoreError::UsageConflict);
    }
    if !equal(&current, &intent["after"])? {
        rows[pos]["lifetimeUsage"] = intent["after"]["lifetimeUsage"].clone();
        rows[pos]["runtimeTurnCount"] = intent["after"]["runtimeTurnCount"].clone();
        rows[pos]["updatedAt"] = json!(now()?);
        log::replace(index_file, &log::encode(rows)?, None)?;
        fault(transaction, "after_index")?;
    }
    if s.found.is_none() {
        if s.tail.is_empty() && s.length != prefix {
            intent["prefixBytes"] = json!(s.length);
            intent["prefixSha256"] = json!(s.sha256);
            log::replace(transaction, &encode(intent, INTENT_BYTES)?, None)?;
        }
        if files::identity(ledger)? != s.version {
            return Err(StoreError::UsageConflict);
        }
        log::append_to_limit(ledger, &line[s.tail.len()..], SAFE, None)?;
        fault(transaction, "after_append")?;
    }
    fs::remove_file(transaction).map_err(|_| StoreError::UsageCommitUncertain)?;
    fault(transaction, "after_cleanup")?;
    log::sync_dir(transaction.parent().ok_or_else(invalid)?)
        .map_err(|_| StoreError::UsageCommitUncertain)
}
fn uncertain(error: StoreError) -> StoreError {
    match error {
        StoreError::UsageInvalid | StoreError::UsageLimit | StoreError::UsageConflict => error,
        _ => StoreError::UsageCommitUncertain,
    }
}

/// One lock owner for recording and recovery; callers cannot change lock order.
struct UsageFiles {
    ledger: PathBuf,
    index: PathBuf,
    intent: PathBuf,
    _locks: [DirectoryLock; 3],
}
impl UsageFiles {
    fn open(store: &ConversationStore, cancel: Option<&AtomicBool>) -> Result<Self> {
        log::check_cancel(cancel)?;
        let directory = log::directory(&store.directory)?;
        let usage = log::directory(&directory.parent().ok_or_else(invalid)?.join("usage"))?;
        let ledger = usage.join("requests.jsonl");
        let index = directory.join("index.jsonl");
        let intent = directory.join(INTENT_FILE);
        let locks = [
            lock_index(&directory, cancel)?,
            DirectoryLock::acquire(&intent, Duration::from_millis(100), cancel)?,
            DirectoryLock::acquire(&ledger, Duration::from_millis(100), cancel)?,
        ];
        Ok(Self {
            ledger,
            index,
            intent,
            _locks: locks,
        })
    }
    fn load(&self, cancel: Option<&AtomicBool>) -> Result<(Vec<Value>, Option<Value>)> {
        let mut rows = log::read(&self.index, cancel)?;
        let recovered = if let Some(bytes) = files::read(&self.intent, INTENT_BYTES)? {
            let mut intent = decode(&bytes, INTENT_BYTES)?;
            recover(
                &self.intent,
                &self.ledger,
                &self.index,
                LEDGER_RELATIVE,
                &mut rows,
                &mut intent,
            )
            .map_err(uncertain)?;
            let pos = position(
                &rows,
                intent["conversationId"].as_str().ok_or_else(invalid)?,
            )?
            .ok_or(StoreError::UsageConflict)?;
            Some(json!({"lifetimeUsage":lifetime(&rows[pos])?,"ledgerRow":intent["ledgerRow"]}))
        } else {
            None
        };
        Ok((rows, recovered))
    }
}

impl ConversationStore {
    /// Reconcile only an existing intent; never synthesize a turn or replay a
    /// model/tool. Also verifies a complete readable ledger before new dispatch.
    pub fn recover_runtime_usage(&self, cancel: Option<&AtomicBool>) -> Result<Option<Value>> {
        let files = UsageFiles::open(self, cancel)?;
        let (_, recovered) = files.load(cancel)?;
        if !scan(&files.ledger, "", "", 0, cancel)?.tail.is_empty() {
            return Err(invalid());
        }
        Ok(recovered)
    }
    /// A completed/errored turn's known usage; duplicates return the original row.
    /// Before the intent, cancellation is safe. After it, finish or retain recovery.
    pub fn record_runtime_turn_usage(
        &self,
        id: &str,
        usage: &RuntimeTurnUsage,
        attribution: &Value,
        cancel: Option<&AtomicBool>,
    ) -> Result<Option<Value>> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput);
        }
        let row = row(id, usage, attribution)?;
        let held = UsageFiles::open(self, cancel)?;
        let (mut rows, _) = held.load(cancel)?;
        let (ledger, index_file, transaction) = (&held.ledger, &held.index, &held.intent);
        let s = scan(
            ledger,
            id,
            row["id"].as_str().ok_or_else(invalid)?,
            0,
            cancel,
        )?;
        if !s.tail.is_empty() {
            return Err(invalid());
        }
        let Some(pos) = position(&rows, id)? else {
            return Ok(None);
        };
        if let Some(old) = s.found {
            for key in [
                "id",
                "conversationId",
                "usageScope",
                "providerRequestCount",
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "cacheWriteTokens",
                "totalTokens",
            ] {
                if !equal(&old[key], &row[key])? {
                    return Err(StoreError::UsageConflict);
                }
            }
            for key in [
                "streamId",
                "modelProviderId",
                "groupId",
                "model",
                "providerName",
                "estimatedCostUsd",
                "pricingSource",
                "role",
                "workspaceId",
            ] {
                if !row[key].is_null() && !equal(&old[key], &row[key])? {
                    return Err(StoreError::UsageConflict);
                }
            }
            return Ok(Some(
                json!({"lifetimeUsage":lifetime(&rows[pos])?,"ledgerRow":old}),
            ));
        }
        let ledger_line = format!("{}\n", javascript_json_string(&row).map_err(|_| invalid())?);
        let mut intent = json!({"schemaVersion":SCHEMA_VERSION,"ledgerRelative":LEDGER_RELATIVE,"conversationId":id,"before":counters(&rows[pos]),"after":next(&rows[pos],&row)?,"ledgerRow":row,"ledgerLine":ledger_line,"prefixBytes":s.length,"prefixSha256":s.sha256});
        let encoded = encode(&intent, INTENT_BYTES)?;
        log::check_cancel(cancel)?;
        log::replace(transaction, &encoded, cancel)?;
        fault(transaction, "after_intent")?;
        recover(
            transaction,
            ledger,
            index_file,
            LEDGER_RELATIVE,
            &mut rows,
            &mut intent,
        )
        .map_err(uncertain)?;
        Ok(Some(
            json!({"lifetimeUsage":lifetime(&rows[pos])?,"ledgerRow":row}),
        ))
    }
}
