use super::{PolicyStore, current, current_optional, finish_write};
use crate::{StoreError, valid_id};
use peer_protocol::{BotAccessPolicy, LocalAccessLevel};
use rusqlite::{OptionalExtension, TransactionBehavior};
use std::{
    fs,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug)]
pub struct PolicyInitialization {
    pub created_authority: bool,
    pub migrated_profiles: usize,
    pub skipped_profiles: Vec<String>,
}
fn check_cancel(cancelled: Option<&AtomicBool>) -> Result<(), StoreError> {
    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        Err(StoreError::Cancelled)
    } else {
        Ok(())
    }
}
fn validate_columns(
    connection: &rusqlite::Connection,
    sql: &str,
    expected: &[(&str, &str, i64, i64)],
) -> Result<(), StoreError> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|_| StoreError::PolicyUnavailable)?;
    let mut rows = statement
        .query([])
        .map_err(|_| StoreError::PolicyUnavailable)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(|_| StoreError::PolicyUnavailable)? {
        let Some((name, kind, not_null, primary_key)) = expected.get(count) else {
            return Err(StoreError::PolicyUnavailable);
        };
        if row
            .get::<_, String>(1)
            .map_err(|_| StoreError::PolicyUnavailable)?
            != *name
            || !row
                .get::<_, String>(2)
                .map_err(|_| StoreError::PolicyUnavailable)?
                .eq_ignore_ascii_case(kind)
            || row
                .get::<_, i64>(3)
                .map_err(|_| StoreError::PolicyUnavailable)?
                != *not_null
            || row
                .get::<_, i64>(5)
                .map_err(|_| StoreError::PolicyUnavailable)?
                != *primary_key
        {
            return Err(StoreError::PolicyUnavailable);
        }
        count += 1;
    }
    if count != expected.len() {
        return Err(StoreError::PolicyUnavailable);
    }
    Ok(())
}

pub(super) fn inspect_schema(
    connection: &rusqlite::Connection,
) -> Result<(i64, Option<String>), StoreError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|_| StoreError::PolicyUnavailable)?;
    if !matches!(version, 0 | 1) {
        return Err(StoreError::PolicyUnavailable);
    }
    let unexpected:i64=connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND ((type='table' AND name NOT IN ('access_policy','access_meta')) OR type IN ('view','trigger'))",[],|r|r.get(0)).map_err(|_|StoreError::PolicyUnavailable)?;
    if unexpected != 0 {
        return Err(StoreError::PolicyUnavailable);
    }
    let policy_exists: bool = connection
        .query_row(
            "SELECT count(*)!=0 FROM sqlite_schema WHERE name='access_policy' AND type='table'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| StoreError::PolicyUnavailable)?;
    if policy_exists {
        validate_columns(
            connection,
            "PRAGMA table_info(access_policy)",
            &[
                ("workspaceId", "TEXT", 1, 1),
                ("conversationId", "TEXT", 1, 0),
                ("revision", "INTEGER", 1, 2),
                ("accessLevel", "TEXT", 1, 0),
                ("updatedAt", "TEXT", 1, 0),
                ("source", "TEXT", 1, 0),
            ],
        )?;
    }
    // Reject an unknown migration marker before changing a valid file's mode.
    let meta_exists: bool = connection
        .query_row(
            "SELECT count(*)!=0 FROM sqlite_schema WHERE name='access_meta' AND type='table'",
            [],
            |r| r.get(0),
        )
        .map_err(|_| StoreError::PolicyUnavailable)?;
    let marker = if meta_exists {
        validate_columns(
            connection,
            "PRAGMA table_info(access_meta)",
            &[("key", "TEXT", 0, 1), ("value", "TEXT", 1, 0)],
        )?;
        let marker: Option<String> = connection
            .query_row(
                "SELECT value FROM access_meta WHERE key='migrated'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        marker
    } else {
        None
    };
    if marker.as_deref().is_some_and(|m| m != "1") {
        return Err(StoreError::PolicyUnavailable);
    }
    Ok((version, marker))
}
pub(super) fn require_initialized(connection: &rusqlite::Connection) -> Result<(), StoreError> {
    let (version, marker) = inspect_schema(connection)?;
    if version != 1 || marker.as_deref() != Some("1") {
        return Err(StoreError::PolicyUnavailable);
    }
    Ok(())
}

impl PolicyStore {
    /// Explicit Host startup migration, never a side effect of read_existing.
    /// The legacy level comes from the existing host settings, not model input.
    pub fn initialize(
        &self,
        legacy_level: LocalAccessLevel,
        updated_at: &str,
        cancelled: Option<&AtomicBool>,
    ) -> Result<PolicyInitialization, StoreError> {
        check_cancel(cancelled)?;
        if updated_at.is_empty() || updated_at.len() > 1024 {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.home.join("project-runtime");
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let directory = fs::canonicalize(directory).map_err(|_| StoreError::PolicyUnavailable)?;
        let path = directory.join("bot-access.sqlite");
        let created_authority = match rustix::fs::open(
            &path,
            rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::EXCL
                | rustix::fs::OFlags::RDWR
                | rustix::fs::OFlags::NOFOLLOW,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        ) {
            Ok(file) => {
                drop(file);
                true
            }
            Err(rustix::io::Errno::EXIST) => false,
            _ => return Err(StoreError::PolicyUnavailable),
        };
        let preflight = self.open_existing(false)?;
        preflight
            .execute_batch("BEGIN DEFERRED")
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let (version, marker) = inspect_schema(&preflight)?;
        if version == 1 && marker.as_deref() == Some("1") {
            return Ok(PolicyInitialization {
                created_authority,
                migrated_profiles: 0,
                skipped_profiles: Vec::new(),
            });
        }
        drop(preflight);
        let mut connection = self.open_existing(true)?;
        inspect_schema(&connection)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .map_err(|_| StoreError::PolicyUnavailable)?;
        if mode != "wal" {
            return Err(StoreError::PolicyUnavailable);
        }
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(|_| StoreError::PolicyUnavailable)?;
        check_cancel(cancelled)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::PolicyUnavailable)?;
        inspect_schema(&transaction)?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS access_policy(workspaceId TEXT NOT NULL,conversationId TEXT NOT NULL,revision INTEGER NOT NULL,accessLevel TEXT NOT NULL,updatedAt TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(workspaceId,revision));CREATE TABLE IF NOT EXISTS access_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);PRAGMA user_version=1;").map_err(|_|StoreError::PolicyUnavailable)?;
        let marker: Option<String> = transaction
            .query_row(
                "SELECT value FROM access_meta WHERE key='migrated'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let mut result = PolicyInitialization {
            created_authority,
            migrated_profiles: 0,
            skipped_profiles: Vec::new(),
        };
        if marker.is_none() {
            // Imported data must not inherit a different device's global Full.
            let imported = match fs::symlink_metadata(directory.join("bot-access-imported.json")) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                _ => return Err(StoreError::PolicyUnavailable),
            };
            let level = if imported {
                LocalAccessLevel::AskBeforeLocal
            } else {
                legacy_level
            };
            let entries = match fs::read_dir(self.home.join("projects")) {
                Ok(entries) => Some(entries),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                _ => return Err(StoreError::PolicyUnavailable),
            };
            let mut scanned = 0usize;
            if let Some(entries) = entries {
                for entry in entries {
                    check_cancel(cancelled)?;
                    scanned += 1;
                    if scanned > 4096 {
                        return Err(StoreError::PolicyLimit);
                    }
                    let entry = entry.map_err(|_| StoreError::PolicyUnavailable)?;
                    if !entry
                        .file_type()
                        .map_err(|_| StoreError::PolicyUnavailable)?
                        .is_dir()
                    {
                        continue;
                    }
                    let Some(id) = entry
                        .file_name()
                        .to_str()
                        .map(str::to_owned)
                        .filter(|id| valid_id(id, true))
                    else {
                        continue;
                    };
                    let conversation = match self.profile(&id) {
                        Ok(id) => id,
                        Err(_) => {
                            result.skipped_profiles.push(id);
                            continue;
                        }
                    };
                    let inserted=transaction.execute("INSERT OR IGNORE INTO access_policy VALUES(?1,?2,1,?3,?4,'legacy_migration')",rusqlite::params![id,conversation,level.as_str(),updated_at]).map_err(|_|StoreError::PolicyUnavailable)?;
                    result.migrated_profiles += inserted;
                }
            }
            transaction
                .execute("INSERT INTO access_meta VALUES('migrated','1')", [])
                .map_err(|_| StoreError::PolicyUnavailable)?;
        } else if marker.as_deref() != Some("1") {
            return Err(StoreError::PolicyUnavailable);
        }
        check_cancel(cancelled)?;
        transaction
            .commit()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        finish_write(&connection)?;
        Ok(result)
    }

    /// Registers an existing active Bot only after the one-time migration has
    /// completed. A new Bot starts Ask even if the old global setting was Full.
    pub fn read_or_register(
        &self,
        workspace_id: &str,
        updated_at: &str,
    ) -> Result<BotAccessPolicy, StoreError> {
        if updated_at.is_empty() || updated_at.len() > 1024 {
            return Err(StoreError::InvalidInput);
        }
        let conversation = self.profile(workspace_id)?;
        let mut connection = self.connect(true)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::PolicyUnavailable)?;
        require_initialized(&transaction)?;
        if current_optional(&transaction, workspace_id)?.is_none() {
            if self.profile(workspace_id)? != conversation {
                return Err(StoreError::OutOfScope);
            }
            transaction
                .execute(
                    "INSERT INTO access_policy VALUES(?1,?2,1,'ask_before_local',?3,'new_bot')",
                    rusqlite::params![workspace_id, conversation, updated_at],
                )
                .map_err(|_| StoreError::PolicyUnavailable)?;
        }
        let policy = current(&transaction, workspace_id)?;
        if policy.conversation_id != conversation || self.profile(workspace_id)? != conversation {
            return Err(StoreError::OutOfScope);
        }
        transaction
            .commit()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        finish_write(&connection)?;
        self.read_existing(workspace_id)
    }
}
