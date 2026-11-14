use crate::{StoreError, files, valid_id};
use peer_protocol::{BotAccessPolicy, JsonLimits, LocalAccessLevel, decode_json_bounded};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

mod initialize;
pub use initialize::PolicyInitialization;

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
    /// ADR 127's separate, user-saved per-Bot unknown-outcome policy. Neither
    /// Full access nor an arbitrary model argument can delegate claim closure.
    pub fn read_unknown_outcome_policy(
        &self,
        workspace: &str,
    ) -> Result<(serde_json::Value, String), StoreError> {
        let conversation = self.profile(workspace)?;
        let path = self
            .home
            .join("projects")
            .join(workspace)
            .join("profile.json");
        let before = files::identity(&path)?.ok_or(StoreError::NotFound)?;
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
        if profile["agentConversationId"] != conversation {
            return Err(StoreError::OutOfScope);
        }
        let stored = &profile["unknownOutcomePolicy"];
        let policy = if stored.is_null() {
            serde_json::json!({"workspaceId":workspace,"agentConversationId":conversation,"tier":"ask"})
        } else {
            if !stored.is_object()
                || !matches!(stored["tier"].as_str(), Some("ask" | "bot_verified"))
                || stored["policyId"]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 4096)
                || stored["revision"].as_f64().is_none_or(|n| {
                    n.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&n)
                })
                || stored["updatedAt"].as_str().is_none_or(str::is_empty)
            {
                return Err(StoreError::PolicyUnavailable);
            }
            let mut p = serde_json::json!({"workspaceId":workspace,"agentConversationId":conversation,"tier":stored["tier"],"policyId":stored["policyId"],"revision":stored["revision"],"updatedAt":stored["updatedAt"]});
            if stored["delegatedAt"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            {
                p["delegatedAt"] = stored["delegatedAt"].clone();
            }
            p
        };
        if files::identity(&path)?.as_ref() != Some(&before)
            || self.profile(workspace)? != conversation
        {
            return Err(StoreError::VersionChanged);
        }
        Ok((policy, files::fingerprint(&[Some(before)])))
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
            || profile["displayName"].as_str().is_none_or(str::is_empty)
            || !(profile["avatar"].is_object() || profile["avatar"].is_array())
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

    fn open_existing(&self, write: bool) -> Result<Connection, StoreError> {
        let file = crate::sqlite_file::SqliteFile::existing(
            &self.home.join("project-runtime/bot-access.sqlite"),
        )
        .map_err(|_| StoreError::PolicyUnavailable)?;
        file.open(write, Duration::from_secs(3))
            .map_err(|_| StoreError::PolicyUnavailable)
    }

    fn connect(&self, write: bool) -> Result<Connection, StoreError> {
        let preflight = self.open_existing(false)?;
        preflight
            .execute_batch("BEGIN DEFERRED")
            .map_err(|_| StoreError::PolicyUnavailable)?;
        initialize::require_initialized(&preflight)?;
        if !write {
            return Ok(preflight);
        }
        drop(preflight);
        let connection = self.open_existing(true)?;
        initialize::require_initialized(&connection)?;
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
        initialize::require_initialized(&transaction)?;
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
        finish_write(&connection)?;
        self.read_existing(workspace_id).map_err(Into::into)
    }
}

fn finish_write(connection: &Connection) -> Result<(), StoreError> {
    // A successful admitted transaction keeps the existing WAL-close behavior.
    // Rejected/rolled-back candidates retain NO_CKPT_ON_CLOSE.
    connection
        .set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
            false,
        )
        .map_err(|_| StoreError::PolicyUnavailable)?;
    Ok(())
}

fn current(connection: &Connection, workspace_id: &str) -> Result<BotAccessPolicy, StoreError> {
    current_optional(connection, workspace_id)?.ok_or(StoreError::PolicyUnavailable)
}
fn current_optional(
    connection: &Connection,
    workspace_id: &str,
) -> Result<Option<BotAccessPolicy>, StoreError> {
    let row: Option<(String, String, i64, String, String, String)> = connection.query_row(
        "SELECT workspaceId,conversationId,revision,accessLevel,updatedAt,source FROM access_policy WHERE workspaceId=?1 ORDER BY revision DESC LIMIT 1",
        [workspace_id], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?))).optional()
        .map_err(|_| StoreError::PolicyUnavailable)?;
    let Some(row) = row else {
        return Ok(None);
    };
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
    Ok(Some(BotAccessPolicy {
        workspace_id: row.0,
        conversation_id: row.1,
        revision: row.2 as u64,
        access_level: level,
        updated_at: row.4,
        source: row.5,
    }))
}
