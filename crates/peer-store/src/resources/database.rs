use super::{ExecutionResourceStore, HostResourcePlan, ResourceError, parse_json, sql_json};
use crate::{
    files,
    sqlite_file::{SqliteFile, SqliteFileError},
};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{
    fs,
    path::Path,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

static SCHEMA: OnceLock<Value> = OnceLock::new();
fn schema() -> &'static Value {
    SCHEMA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/execution-resources-v3.json"
        ))
        .expect("compiled resource schema")
    })
}
fn mapped(error: SqliteFileError) -> ResourceError {
    match error {
        SqliteFileError::Unavailable => ResourceError::Unavailable,
        SqliteFileError::Changed => ResourceError::Changed,
    }
}
fn cancel(cancelled: Option<&AtomicBool>) -> Result<(), ResourceError> {
    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        Err(ResourceError::Cancelled)
    } else {
        Ok(())
    }
}
pub(super) fn inspect_schema(c: &Connection, complete: bool) -> Result<u64, ResourceError> {
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if !(0..=3).contains(&version) || (complete && version != 3) {
        return Err(ResourceError::Schema);
    }
    let mut objects =
        c.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 257")?;
    let actual: Vec<(String, String)> = objects
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    if actual.len() > 256 {
        return Err(ResourceError::Limit);
    }
    for (kind, name) in &actual {
        let list = match kind.as_str() {
            "table" => &schema()["tables"],
            "index" => &schema()["indexes"],
            _ => return Err(ResourceError::Schema),
        };
        if !list
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["name"].as_str() == Some(name))
        {
            return Err(ResourceError::Schema);
        }
    }
    for table in schema()["tables"].as_array().unwrap() {
        let name = table["name"].as_str().unwrap();
        if !actual.iter().any(|(kind, n)| kind == "table" && n == name) {
            if complete || version == 3 {
                return Err(ResourceError::Schema);
            }
            continue;
        }
        let mut statement = c.prepare(&format!("PRAGMA table_info({name})"))?;
        let columns: Vec<(String, String, i64, i64)> = statement
            .query_map([], |r| Ok((r.get(1)?, r.get(2)?, r.get(3)?, r.get(5)?)))?
            .collect::<Result<_, _>>()?;
        let expected = table["columns"].as_array().unwrap();
        if columns.len() != expected.len()
            || columns.iter().zip(expected).any(|((n, t, nn, pk), e)| {
                e["name"].as_str() != Some(n)
                    || !t.eq_ignore_ascii_case(e["type"].as_str().unwrap())
                    || e["notnull"].as_i64() != Some(*nn)
                    || e["pk"].as_i64() != Some(*pk)
            })
        {
            return Err(ResourceError::Schema);
        }
    }
    Ok(version as u64)
}
fn missing_ledger_check(directory: &Path) -> Result<(), ResourceError> {
    let mut scanned = 0;
    for entry in fs::read_dir(directory).map_err(|_| ResourceError::Unavailable)? {
        scanned += 1;
        if scanned > 4096 {
            return Err(ResourceError::Limit);
        }
        let entry = entry.map_err(|_| ResourceError::Unavailable)?;
        if !entry
            .file_type()
            .map_err(|_| ResourceError::Unavailable)?
            .is_dir()
        {
            continue;
        }
        let file = entry.path().join("coordination-v2/manifest.json");
        if let Some(bytes) = files::read(&file, 256 * 1024).map_err(|_| ResourceError::Invalid)? {
            let text = std::str::from_utf8(&bytes).map_err(|_| ResourceError::Invalid)?;
            let manifest = parse_json(text)?;
            let version = manifest["minimumWriterVersion"]
                .as_u64()
                .ok_or(ResourceError::Schema)?;
            if version == 7 || version >= 9 {
                return Err(ResourceError::Missing);
            }
        }
    }
    Ok(())
}
impl ExecutionResourceStore {
    /// Explicit Host initialization. A lost ledger for format 7 or >=9 is never
    /// replaced with an empty one. Unknown/corrupt files and WALs are preserved.
    pub fn initialize(
        data_home: impl AsRef<Path>,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Self, ResourceError> {
        cancel(cancelled)?;
        let directory = data_home.as_ref().join("project-runtime");
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| ResourceError::Unavailable)?;
        let path = directory.join("execution-resources.sqlite");
        if !path.exists() {
            missing_ledger_check(&directory)?;
            cancel(cancelled)?;
            match rustix::fs::open(
                &path,
                rustix::fs::OFlags::CREATE
                    | rustix::fs::OFlags::EXCL
                    | rustix::fs::OFlags::RDWR
                    | rustix::fs::OFlags::NOFOLLOW,
                rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
            ) {
                Ok(fd) => drop(fd),
                Err(rustix::io::Errno::EXIST) => {}
                _ => return Err(ResourceError::Unavailable),
            }
        }
        let file = SqliteFile::existing(&path).map_err(mapped)?;
        let read = file
            .open(false, Duration::from_millis(100))
            .map_err(mapped)?;
        read.execute_batch("BEGIN DEFERRED")?;
        inspect_schema(&read, false)?;
        drop(read);
        cancel(cancelled)?;
        let mut c = file
            .open(true, Duration::from_millis(100))
            .map_err(mapped)?;
        inspect_schema(&c, false)?;
        c.pragma_update(None, "journal_mode", "WAL")?;
        c.pragma_update(None, "synchronous", "FULL")?;
        let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        inspect_schema(&transaction, false)?;
        for table in schema()["tables"].as_array().unwrap() {
            transaction.execute_batch(&table["sql"].as_str().unwrap().replacen(
                "CREATE TABLE ",
                "CREATE TABLE IF NOT EXISTS ",
                1,
            ))?;
        }
        for index in schema()["indexes"].as_array().unwrap() {
            transaction.execute_batch(&index["sql"].as_str().unwrap().replacen(
                "CREATE INDEX ",
                "CREATE INDEX IF NOT EXISTS ",
                1,
            ))?;
        }
        transaction.pragma_update(None, "user_version", 3)?;
        inspect_schema(&transaction, true)?;
        cancel(cancelled)?;
        transaction.commit()?;
        file.check_current().map_err(mapped)?;
        Ok(Self {
            file,
            connection: c,
            writable: true,
        })
    }
    /// A read-only snapshot source: no create, migration, schema repair or write.
    pub fn open_existing(data_home: impl AsRef<Path>) -> Result<Self, ResourceError> {
        let file = SqliteFile::existing(
            &data_home
                .as_ref()
                .join("project-runtime/execution-resources.sqlite"),
        )
        .map_err(mapped)?;
        let c = file
            .open(false, Duration::from_millis(100))
            .map_err(mapped)?;
        inspect_schema(&c, true)?;
        Ok(Self {
            file,
            connection: c,
            writable: false,
        })
    }
    pub(super) fn read<T>(
        &self,
        run: impl FnOnce(&Connection) -> Result<T, ResourceError>,
    ) -> Result<T, ResourceError> {
        self.file.check_current().map_err(mapped)?;
        let transaction = self.connection.unchecked_transaction()?;
        inspect_schema(&transaction, true)?;
        let value = run(&transaction)?;
        self.file.check_current().map_err(mapped)?;
        transaction.commit()?;
        Ok(value)
    }
    pub(super) fn transaction<T>(
        &mut self,
        run: impl FnOnce(&Connection) -> Result<T, ResourceError>,
    ) -> Result<T, ResourceError> {
        if !self.writable {
            return Err(ResourceError::ReadOnly);
        }
        self.file.check_current().map_err(mapped)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        inspect_schema(&transaction, true)?;
        let value = run(&transaction)?;
        self.file.check_current().map_err(mapped)?;
        transaction.commit()?;
        Ok(value)
    }
    pub fn revision(&self) -> Result<u64, ResourceError> {
        self.read(|c| {
            let n: i64 = c.query_row(
                "SELECT COALESCE(MAX(revision),0) FROM resource_events",
                [],
                |r| r.get(0),
            )?;
            u64::try_from(n).map_err(|_| ResourceError::Invalid)
        })
    }
}
pub(super) fn get(c: &Connection, table: &str, id: &str) -> Result<Option<Value>, ResourceError> {
    let query = match table {
        "claims" => "SELECT value FROM claims WHERE id=?",
        "receipts" => "SELECT value FROM receipts WHERE id=?",
        "requirements" => "SELECT value FROM requirements WHERE planId=?",
        "closures" => "SELECT value FROM closures WHERE id=?",
        "reconciliation_evidence" => "SELECT value FROM reconciliation_evidence WHERE id=?",
        _ => return Err(ResourceError::Invalid),
    };
    c.query_row(query, [id], |r| r.get::<_, String>(0))
        .optional()?
        .map(|s| parse_json(&s))
        .transpose()
}
pub(super) fn values(
    c: &Connection,
    query: &str,
    args: impl rusqlite::Params,
) -> Result<Vec<Value>, ResourceError> {
    let mut statement = c.prepare(query)?;
    let mut rows = statement.query(args)?;
    let mut result = Vec::new();
    let mut bytes = 0usize;
    let mut nodes = 65_536;
    let mut strings = 8 * 1024 * 1024;
    while let Some(row) = rows.next()? {
        let text: String = row.get(0)?;
        bytes = bytes.checked_add(text.len()).ok_or(ResourceError::Limit)?;
        if bytes > 8 * 1024 * 1024 || result.len() >= 4096 {
            return Err(ResourceError::Limit);
        }
        let decoded = peer_protocol::decode_json_bounded(
            text.as_bytes(),
            peer_protocol::JsonLimits {
                bytes: 1_048_576,
                nodes,
                depth: 64,
                string_bytes: strings,
            },
        )
        .map_err(|e| match e {
            peer_protocol::JsonDecodeError::LimitExceeded => ResourceError::Limit,
            peer_protocol::JsonDecodeError::InvalidJson => ResourceError::Invalid,
        })?;
        nodes -= decoded.nodes;
        strings -= decoded.string_bytes;
        result.push(decoded.value);
    }
    Ok(result)
}
pub(super) fn same(raw: &Value, execution: &peer_protocol::SessionExecutionIdentity) -> bool {
    peer_protocol::normalize_session_execution_identity(raw).as_ref() == Some(execution)
}
pub(super) fn has_closure(c: &Connection, p: &HostResourcePlan) -> Result<bool, ResourceError> {
    Ok(values(
        c,
        "SELECT value FROM closures WHERE planId=? AND sessionId=? AND epoch=?",
        rusqlite::params![
            p.execution.plan_id,
            p.execution.session_id,
            p.execution.execution_epoch
        ],
    )?
    .iter()
    .any(|v| same(&v["execution"], &p.execution)))
}
pub(super) fn put_claim(c: &Connection, claim: &Value) -> Result<(), ResourceError> {
    let e = peer_protocol::normalize_session_execution_identity(&claim["execution"])
        .ok_or(ResourceError::Invalid)?;
    c.execute(
        "INSERT OR REPLACE INTO claims VALUES(?,?,?,?,?,?,?,?,?)",
        rusqlite::params![
            super::text(&claim["claimId"])?,
            e.plan_id,
            e.session_id,
            super::text(&claim["workspaceId"])?,
            super::text(&claim["resourceRef"])?,
            e.execution_epoch,
            super::text(&claim["state"])?,
            super::revision(&claim["revision"])? as i64,
            sql_json(claim)?
        ],
    )?;
    Ok(())
}
