use crate::{StoreError, files, valid_id};
use peer_protocol::{BotAccessPolicy, JsonLimits, LocalAccessLevel, decode_json_bounded};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub struct PolicyStore {
    home: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PolicyUpdateError {
    Store(StoreError),
    Conflict(BotAccessPolicy),
}
impl From<StoreError> for PolicyUpdateError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl PolicyStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            home: data_home.as_ref().to_owned(),
        }
    }

    fn profile(&self, workspace_id: &str) -> Result<String, StoreError> {
        if !valid_id(workspace_id, true) {
            return Err(StoreError::InvalidInput);
        }
        let path = self
            .home
            .join("projects")
            .join(workspace_id)
            .join("profile.json");
        let bytes = files::read(&path, 1_048_576)?.ok_or(StoreError::NotFound)?;
        let profile = decode_json_bounded(
            &bytes,
            JsonLimits {
                bytes: 1_048_576,
                nodes: 4096,
                depth: 64,
                string_bytes: 1_048_576,
            },
        )
        .map_err(|_| StoreError::PolicyUnavailable)?
        .value;
        if profile["workspaceId"].as_str() != Some(workspace_id)
            || profile
                .get("status")
                .is_some_and(|status| !status.is_null() && status.as_str() != Some("active"))
        {
            return Err(StoreError::NotFound);
        }
        profile["agentConversationId"]
            .as_str()
            .filter(|id| valid_id(id, false))
            .map(str::to_owned)
            .ok_or(StoreError::NotFound)
    }

    fn connect(&self, write: bool) -> Result<Connection, StoreError> {
        // SQLite NOFOLLOW also rejects symlinked parent components (e.g.
        // macOS /var -> /private/var). Canonicalize only the parent; keep the
        // policy filename unfollowed and reject a symlink at that final path.
        let directory = std::fs::canonicalize(self.home.join("project-runtime"))
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let path = directory.join("bot-access.sqlite");
        let meta = std::fs::symlink_metadata(&path).map_err(|_| StoreError::PolicyUnavailable)?;
        if !meta.is_file() {
            return Err(StoreError::PolicyUnavailable);
        }
        let access = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let connection = Connection::open_with_flags(
            path,
            access | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| StoreError::PolicyUnavailable)?;
        connection
            .busy_timeout(Duration::from_secs(3))
            .map_err(|_| StoreError::PolicyUnavailable)?;
        connection
            .pragma_update(None, "cache_size", -2048)
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let quick: String = connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|_| StoreError::PolicyUnavailable)?;
        if quick != "ok" || version != 1 {
            return Err(StoreError::PolicyUnavailable);
        }
        let migrated: Option<String> = connection
            .query_row(
                "SELECT value FROM access_meta WHERE key='migrated'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        if migrated.as_deref() != Some("1") {
            return Err(StoreError::PolicyUnavailable);
        }
        Ok(connection)
    }

    /// Reads an existing initialized policy only; never reconstructs a bad DB
    /// or silently migrates an old Full setting. Host migration is separate.
    pub fn read_existing(&self, workspace_id: &str) -> Result<BotAccessPolicy, StoreError> {
        let conversation = self.profile(workspace_id)?;
        let connection = self.connect(false)?;
        let policy = current(&connection, workspace_id)?;
        if policy.conversation_id != conversation || self.profile(workspace_id)? != conversation {
            return Err(StoreError::OutOfScope);
        }
        Ok(policy)
    }

    /// Local policy administration port; not a Tool Call or PermissionGrant.
    /// No CLI/Provider entry exposes this while P2 admission remains unfinished.
    pub fn update_existing(
        &self,
        workspace_id: &str,
        expected_revision: u64,
        level: LocalAccessLevel,
        updated_at: &str,
    ) -> Result<BotAccessPolicy, PolicyUpdateError> {
        if expected_revision == 0 || expected_revision >= MAX_SAFE_INTEGER {
            return Err(StoreError::InvalidInput.into());
        }
        let conversation = self.profile(workspace_id)?;
        let mut connection = self.connect(true)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| StoreError::PolicyUnavailable)?;
        let before = current(&transaction, workspace_id)?;
        if before.conversation_id != conversation || self.profile(workspace_id)? != conversation {
            return Err(StoreError::OutOfScope.into());
        }
        if before.revision != expected_revision {
            return Err(PolicyUpdateError::Conflict(before));
        }
        if before.access_level != level {
            transaction
                .execute(
                    "INSERT INTO access_policy VALUES(?1,?2,?3,?4,?5,'local_ui')",
                    rusqlite::params![
                        workspace_id,
                        conversation,
                        before.revision + 1,
                        level.as_str(),
                        updated_at
                    ],
                )
                .map_err(|_| StoreError::PolicyUnavailable)?;
        }
        transaction
            .commit()
            .map_err(|_| StoreError::PolicyUnavailable)?;
        self.read_existing(workspace_id).map_err(Into::into)
    }
}

fn current(connection: &Connection, workspace_id: &str) -> Result<BotAccessPolicy, StoreError> {
    let row: (String, String, i64, String, String, String) = connection.query_row(
        "SELECT workspaceId,conversationId,revision,accessLevel,updatedAt,source FROM access_policy WHERE workspaceId=?1 ORDER BY revision DESC LIMIT 1",
        [workspace_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .map_err(|_| StoreError::PolicyUnavailable)?;
    let level = match row.3.as_str() {
        "ask_before_local" => LocalAccessLevel::AskBeforeLocal,
        "session_local" => LocalAccessLevel::SessionLocal,
        "restricted_local" => LocalAccessLevel::RestrictedLocal,
        "full_local" => LocalAccessLevel::FullLocal,
        _ => return Err(StoreError::PolicyUnavailable),
    };
    if row.0 != workspace_id
        || row.2 <= 0
        || row.2 as u64 > MAX_SAFE_INTEGER
        || !matches!(row.5.as_str(), "legacy_migration" | "new_bot" | "local_ui")
    {
        return Err(StoreError::PolicyUnavailable);
    }
    Ok(BotAccessPolicy {
        workspace_id: row.0,
        conversation_id: row.1,
        revision: row.2 as u64,
        access_level: level,
        updated_at: row.4,
        source: row.5,
    })
}
