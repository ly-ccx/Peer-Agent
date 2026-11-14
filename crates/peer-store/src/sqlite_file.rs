//! Shared local SQLite file admission. Never creates or repairs a database.
use crate::files;
use rusqlite::{Connection, OpenFlags, config::DbConfig, limits::Limit};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Copy)]
pub(crate) enum SqliteFileError {
    Unavailable,
    Changed,
}
pub(crate) struct SqliteFile {
    path: PathBuf,
    device: u64,
    inode: u64,
}
impl SqliteFile {
    pub fn existing(path: &Path) -> Result<Self, SqliteFileError> {
        let parent = fs::canonicalize(path.parent().ok_or(SqliteFileError::Unavailable)?)
            .map_err(|_| SqliteFileError::Unavailable)?;
        let path = parent.join(path.file_name().ok_or(SqliteFileError::Unavailable)?);
        let Some((_file, identity)) =
            files::open(&path, u64::MAX).map_err(|_| SqliteFileError::Unavailable)?
        else {
            return Err(SqliteFileError::Unavailable);
        };
        Ok(Self {
            path,
            device: identity.dev,
            inode: identity.ino,
        })
    }
    pub fn check_current(&self) -> Result<(), SqliteFileError> {
        let Some(id) = files::identity(&self.path).map_err(|_| SqliteFileError::Changed)? else {
            return Err(SqliteFileError::Changed);
        };
        let meta = fs::symlink_metadata(&self.path).map_err(|_| SqliteFileError::Changed)?;
        if !meta.is_file() || id.dev != self.device || id.ino != self.inode {
            return Err(SqliteFileError::Changed);
        }
        Ok(())
    }
    pub fn open(&self, write: bool, busy: Duration) -> Result<Connection, SqliteFileError> {
        self.check_current()?;
        let access = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        let c = Connection::open_with_flags(
            &self.path,
            access | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| SqliteFileError::Unavailable)?;
        // A rejected or rolled-back connection must not checkpoint a foreign WAL.
        c.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(|_| SqliteFileError::Unavailable)?;
        for (limit, value) in [
            (Limit::SQLITE_LIMIT_LENGTH, 1_048_576),
            (Limit::SQLITE_LIMIT_SQL_LENGTH, 16_384),
            (Limit::SQLITE_LIMIT_COLUMN, 32),
        ] {
            c.set_limit(limit, value)
                .map_err(|_| SqliteFileError::Unavailable)?;
        }
        c.busy_timeout(busy)
            .map_err(|_| SqliteFileError::Unavailable)?;
        c.pragma_update(None, "cache_size", -2048)
            .map_err(|_| SqliteFileError::Unavailable)?;
        let check: String = c
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(|_| SqliteFileError::Unavailable)?;
        if check != "ok" {
            return Err(SqliteFileError::Unavailable);
        }
        self.check_current()?;
        Ok(c)
    }
}
