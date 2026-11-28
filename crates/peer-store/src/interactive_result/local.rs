use super::*;
use crate::sqlite_file::{SqliteFile, SqliteFileError, SqliteReadSnapshot};
use peer_protocol::interactive_result::{
    INTERACTIVE_MANIFEST_BYTES, INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL,
    INTERACTIVE_SUMMARY_UNITS, interactive_canonical_json, interactive_digest,
    interactive_json_digest,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata},
    io::{self, Read as _},
    path::PathBuf,
};

pub(super) mod tombstone;

const LIMIT: usize = INTERACTIVE_MANIFEST_BYTES;
const STORAGE: InteractiveReadError = InteractiveReadError("interactive_storage_unavailable");
const CHANGED: InteractiveReadError = InteractiveReadError("interactive_storage_replaced");
const CORRUPT: InteractiveReadError = InteractiveReadError("interactive_storage_corrupt");
const INCOMPATIBLE: InteractiveReadError = InteractiveReadError("interactive_storage_incompatible");
const PUBLICATION: InteractiveReadError =
    InteractiveReadError("interactive_publication_unavailable");
const CONTENT_CORRUPT: InteractiveReadError = InteractiveReadError("interactive_content_corrupt");
const CONTENT_MISSING: InteractiveReadError = InteractiveReadError("interactive_content_missing");

struct Snapshot {
    directory: PathBuf,
    entries: [Option<files::FileIdentity>; 4],
    directories: [(u64, u64); 2],
}

impl Snapshot {
    fn capture(directory: PathBuf) -> Read<Option<Self>> {
        let project = directory.parent().ok_or(STORAGE)?;
        let Some(project_meta) = stat(project, Metadata::is_dir)? else {
            return Ok(None);
        };
        let Some(dir_meta) = stat(&directory, Metadata::is_dir)? else {
            return Ok(None);
        };
        let mut entries = [None, None, None, None];
        for (i, name) in [
            "store.sqlite",
            "store.sqlite-wal",
            "store.sqlite-shm",
            "store.sqlite-journal",
        ]
        .iter()
        .enumerate()
        {
            let file = directory.join(name);
            if let Some(meta) = stat(&file, |m| {
                m.is_file() && crate::platform::metadata_nlink_is_one(m)
            })? {
                let current = files::identity(&file)
                    .map_err(|_| STORAGE)?
                    .ok_or(CHANGED)?;
                if (current.dev, current.ino) != dir_id(&meta) {
                    return Err(CHANGED);
                }
                entries[i] = Some(current);
            }
        }
        if entries[0].is_none() {
            return Err(InteractiveReadError("interactive_storage_missing"));
        }
        Ok(Some(Self {
            directory,
            entries,
            directories: [dir_id(&project_meta), dir_id(&dir_meta)],
        }))
    }

    fn mode(&self) -> Read<SqliteReadSnapshot> {
        if self.entries[3].as_ref().is_some_and(|v| v.size != 0) {
            return Err(INCOMPATIBLE);
        }
        if self.entries[1].as_ref().is_none_or(|wal| wal.size == 0) {
            return Ok(SqliteReadSnapshot::Checkpointed);
        }
        Ok(
            if self.entries[2].as_ref().is_none_or(|shm| shm.size == 0) {
                SqliteReadSnapshot::RebuildWalIndex
            } else {
                SqliteReadSnapshot::SharedWal
            },
        )
    }

    fn connect(&self, mode: SqliteReadSnapshot) -> Read<Connection> {
        let file =
            SqliteFile::existing(&self.directory.join("store.sqlite")).map_err(storage_error)?;
        let db = file
            .open_read_snapshot(mode, (LIMIT + 8192) as i32)
            .map_err(storage_error)?;
        if db
            .query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))
            .ok()
            != Some(5)
        {
            return Err(INCOMPATIBLE);
        }
        Ok(db)
    }

    fn current(&self) -> Read<Self> {
        Self::capture(self.directory.clone())
            .map_err(|_| CHANGED)?
            .ok_or(CHANGED)
    }

    fn check_current(&self, mode: SqliteReadSnapshot) -> Read<()> {
        self.compare(&self.current()?, mode, None)
    }

    fn compare(
        &self,
        after: &Self,
        mode: SqliteReadSnapshot,
        rebuild_wal_digest: Option<[u8; 32]>,
    ) -> Read<()> {
        if after.directories != self.directories {
            return Err(CHANGED);
        }
        for (index, (before, current)) in self.entries.iter().zip(&after.entries).enumerate() {
            let unchanged = if let (1, Some(digest), Some(old), Some(new)) =
                (index, rebuild_wal_digest, before, current)
            {
                // Linux SQLite may update the WAL's ctime when rebuilding its
                // index. Prove identical bytes before adopting that metadata.
                old.dev == new.dev
                    && old.ino == new.ino
                    && old.size == new.size
                    && old.modified_ns == new.modified_ns
                    && after.wal_digest()? == digest
            } else if index == 2 && matches!(mode, SqliteReadSnapshot::RebuildWalIndex) {
                before.as_ref().is_none_or(|old| {
                    current
                        .as_ref()
                        .is_some_and(|new| old.dev == new.dev && old.ino == new.ino)
                })
            } else {
                before == current
            };
            if !unchanged {
                return Err(CHANGED);
            }
        }
        Ok(())
    }

    fn wal_digest(&self) -> Read<[u8; 32]> {
        let expected = self.entries[1].as_ref().ok_or(CHANGED)?;
        let path = self.directory.join("store.sqlite-wal");
        let (file, identity) = files::open(&path, expected.size)
            .map_err(|_| CHANGED)?
            .ok_or(CHANGED)?;
        if &identity != expected {
            return Err(CHANGED);
        }
        let mut digest = Sha256::new();
        let read = io::copy(&mut file.take(expected.size.saturating_add(1)), &mut digest)
            .map_err(|_| CHANGED)?;
        if read != expected.size
            || files::identity(&path).map_err(|_| CHANGED)?.as_ref() != Some(expected)
        {
            return Err(CHANGED);
        }
        Ok(digest.finalize().into())
    }
}

fn dir_id(meta: &Metadata) -> (u64, u64) {
    crate::platform::metadata_dev_ino(meta)
}

fn stat(path: &Path, valid: impl FnOnce(&Metadata) -> bool) -> Read<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if valid(&meta) => Ok(Some(meta)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err(STORAGE),
    }
}

fn storage_error(error: SqliteFileError) -> InteractiveReadError {
    match error {
        SqliteFileError::Unavailable => INCOMPATIBLE,
        SqliteFileError::Changed => CHANGED,
    }
}

pub(super) fn read_local(
    home: &Path,
    reference: &InteractiveResultReference,
) -> Read<Option<InteractiveResultSummary>> {
    read_snapshot(home, &reference.owner, |db| read_fixed(db, reference))
}

pub(super) fn read_snapshot<T>(
    home: &Path,
    owner: &InteractiveOwner,
    read: impl FnOnce(&Connection) -> Read<Option<T>>,
) -> Read<Option<T>> {
    let runtime = home.join("project-runtime");
    if stat(&runtime, Metadata::is_dir)?.is_none() {
        return Ok(None);
    }
    let directory = runtime
        .join(&owner.workspace_id)
        .join("interactive-results");
    let Some(snapshot) = Snapshot::capture(directory)? else {
        return Ok(None);
    };
    let mode = snapshot.mode()?;
    let rebuild_wal_digest = (cfg!(target_os = "linux")
        && matches!(mode, SqliteReadSnapshot::RebuildWalIndex))
    .then(|| snapshot.wal_digest())
    .transpose()?;
    let db = snapshot.connect(mode)?;
    let admitted = snapshot.current()?;
    snapshot.compare(&admitted, mode, rebuild_wal_digest)?;
    let saved = read(&db);
    admitted.check_current(mode)?;
    saved
}

struct Version {
    metadata: Value,
    object: String,
    availability: String,
}

fn owner_json(reference: &InteractiveResultReference) -> Read<String> {
    interactive_canonical_json(&json!(reference.owner)).map_err(|_| CORRUPT)
}

fn version(db: &Connection, reference: &InteractiveResultReference) -> Read<Option<Version>> {
    let row = db
        .query_row(
            "SELECT owner, object, metadata, availability FROM versions WHERE id=? AND version=?",
            params![reference.result_id, reference.content_version],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| CORRUPT)?;
    let Some((owner, object, metadata, availability)) = row else {
        return Ok(None);
    };
    if owner != owner_json(reference)? {
        return Err(DENIED);
    }
    let metadata = decode(metadata.as_bytes(), LIMIT).ok_or(CORRUPT)?;
    if !ref_equals(&metadata["reference"], reference)
        || !matches!(availability.as_str(), "available" | "cleaned")
    {
        return Err(CORRUPT);
    }
    Ok(Some(Version {
        metadata,
        object,
        availability,
    }))
}

fn phase(db: &Connection, metadata: &Value) -> Read<()> {
    let id = metadata["operationId"]
        .as_str()
        .filter(|id| interactive_digest(id))
        .ok_or(CORRUPT)?;
    let phase: Option<String> = db
        .query_row("SELECT phase FROM operations WHERE id=?", [id], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|_| CORRUPT)?;
    match phase.as_deref() {
        Some("published") => Ok(()),
        Some("index_pending") => Err(InteractiveReadError("publication_index_pending")),
        _ => Err(UNAVAILABLE),
    }
}

fn operation(
    db: &Connection,
    reference: &InteractiveResultReference,
    metadata: &Value,
    origin: &InteractiveResultSource,
    allow_pending: bool,
) -> Read<Value> {
    let call = json!({"owner":reference.owner, "conversationId":origin.conversation_id, "toolCallId":origin.tool_call_id});
    let operation_id = interactive_json_digest(&json!([
        reference.owner,
        origin.conversation_id,
        origin.tool_call_id
    ]))
    .map_err(|_| CORRUPT)?;
    if metadata["operationId"] != operation_id {
        return Err(CORRUPT);
    }
    let (owner, conversation, tool, phase, receipt): (String, String, String, String, String) = db
        .query_row(
            "SELECT owner, conversation, toolCallId, phase, receipt FROM operations WHERE id=?",
            [&operation_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|_| CORRUPT)?
        .ok_or(PUBLICATION)?;
    if owner != owner_json(reference)?
        || conversation != origin.conversation_id
        || tool != origin.tool_call_id
    {
        return Err(InteractiveReadError("interactive_operation_conflict"));
    }
    let receipt = decode(receipt.as_bytes(), LIMIT).ok_or(CORRUPT)?;
    if !(phase == "published" || allow_pending && phase == "index_pending")
        || receipt["unchanged"] == true
        || receipt["metadata"] != *metadata
        || !ref_equals(&receipt["reference"], reference)
        || receipt["callRef"] != call
    {
        return Err(PUBLICATION);
    }
    Ok(receipt)
}

fn body(db: &Connection, reference: &InteractiveResultReference, row: &Version) -> Read<Value> {
    let (encoded, bytes): (String, usize) = db
        .query_row(
            "SELECT body,bytes FROM objects WHERE hash=?",
            [&row.object],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| CONTENT_CORRUPT)?
        .ok_or(CONTENT_MISSING)?;
    if encoded.len() != bytes {
        return Err(CONTENT_MISSING);
    }
    let mut value = decode(encoded.as_bytes(), LIMIT).ok_or(CONTENT_CORRUPT)?;
    if interactive_json_digest(&value).map_err(|_| CONTENT_CORRUPT)? != row.object
        || value["encoding"] != "peer-interactive-content-1"
        || value["dataLevel"] != row.metadata["dataLevel"]
    {
        return Err(CONTENT_CORRUPT);
    }
    for record in value["provenance"].as_array_mut().ok_or(CONTENT_CORRUPT)? {
        let object = record.as_object_mut().ok_or(CONTENT_CORRUPT)?;
        object.remove("capturedAt");
        if let Some(origin) = object.get_mut("source").and_then(Value::as_object_mut)
            && origin.get("kind").is_some_and(|kind| kind == "model-data")
        {
            origin.remove("observedAt");
        }
    }
    let identity = json!({
        "encoding": value["encoding"], "content": value["content"],
        "provenance": value["provenance"], "dataLevel": value["dataLevel"],
    });
    if interactive_json_digest(&identity).map_err(|_| CONTENT_CORRUPT)? != reference.content_version
    {
        return Err(CONTENT_CORRUPT);
    }
    Ok(value["content"].take())
}

fn data_level(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|level| {
            matches!(
                *level,
                "D0_public" | "D1_internal" | "D2_sensitive" | "D3_private" | "D4_regulated"
            )
        })
        .map(str::to_owned)
}

fn read_fixed(
    db: &Connection,
    reference: &InteractiveResultReference,
) -> Read<Option<InteractiveResultSummary>> {
    let Some(row) = version(db, reference)? else {
        return Ok(None);
    };
    if row.availability == "cleaned" {
        return tombstone::read(db, reference).map(Some);
    }
    phase(db, &row.metadata)?;
    let content = body(db, reference, &row)?;
    let origin = source(&row.metadata["source"]).ok_or(PUBLICATION)?;
    let operation = operation(db, reference, &row.metadata, &origin, false)?;
    let locator = reference.locator();
    let index = &operation["indexEntry"];
    let artifact = artifact(index, reference, &locator).ok_or(PUBLICATION)?;
    if index["evidenceRef"] != locator
        || index["capabilityId"] != INTERACTIVE_PUBLISH_CAPABILITY
        || index["toolName"] != INTERACTIVE_PUBLISH_TOOL
        || index["planId"] != origin.plan_id
        || index["conversationId"] != origin.conversation_id
        || index["toolCallId"] != origin.tool_call_id
        || !included(&index["artifactRefs"], &locator)
        || row.metadata["evidenceRef"] != locator
        || row.metadata["artifactRef"] != locator
        || artifact["specHash"] != content["specHash"]
        || artifact["label"] != content["title"]
    {
        return Err(PUBLICATION);
    }
    let schema = content["schemaVersion"]
        .as_u64()
        .filter(|schema| *schema == 1)
        .ok_or(CONTENT_CORRUPT)?;
    let library = content["libraryVersion"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256)
        .ok_or(CONTENT_CORRUPT)?;
    let title = content["title"].as_str().ok_or(PUBLICATION)?;
    let fallback = content["textFallback"]
        .as_str()
        .filter(|s| s.len() <= FALLBACK_BYTES)
        .ok_or(PUBLICATION)?;
    let mut remaining = INTERACTIVE_SUMMARY_UNITS;
    let (end, partial) = fallback
        .char_indices()
        .find_map(|(index, c)| {
            let Some(remainder) = remaining.checked_sub(c.len_utf16()) else {
                let unit = (remaining == 1).then(|| c.encode_utf16(&mut [0; 2])[0]);
                return Some((index, unit));
            };
            remaining = remainder;
            None
        })
        .unwrap_or((fallback.len(), None));
    let mut result = summary(
        reference,
        InteractiveAvailability::Available,
        origin,
        title.into(),
        fallback[..end].into(),
        end != fallback.len(),
    );
    if let Some(unit) = partial {
        result.text_fallback = result
            .text_fallback
            .with_partial_character(unit)
            .ok_or(CONTENT_CORRUPT)?;
    }
    result.data_level = Some(data_level(&row.metadata["dataLevel"]).ok_or(CONTENT_CORRUPT)?);
    result.content_schema_version = Some(schema);
    result.library_version = Some(library.into());
    Ok(Some(result))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn wal_rebuild_checks_bytes_when_only_ctime_changes() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("bot").join("interactive-results");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("store.sqlite"), b"database").unwrap();
        let wal = directory.join("store.sqlite-wal");
        fs::write(&wal, b"committed").unwrap();
        let before = Snapshot::capture(directory.clone()).unwrap().unwrap();
        let digest = before.wal_digest().unwrap();
        let modified = fs::metadata(&wal).unwrap().modified().unwrap();

        fs::write(&wal, b"different").unwrap();
        fs::File::open(&wal)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let after = Snapshot::capture(directory).unwrap().unwrap();
        assert_eq!(
            after.entries[1].as_ref().unwrap().modified_ns,
            before.entries[1].as_ref().unwrap().modified_ns
        );
        assert_eq!(
            before.compare(&after, SqliteReadSnapshot::RebuildWalIndex, Some(digest)),
            Err(CHANGED)
        );
    }
}
