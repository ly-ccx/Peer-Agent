//! Shared local SQLite file admission. Never creates or repairs a database.
use crate::files;
use rusqlite::{Connection, OpenFlags, config::DbConfig, limits::Limit};
use std::{
    fmt::Write as _,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Debug, Clone, Copy)]
pub(crate) enum SqliteFileError {
    Unavailable,
    Changed,
}

#[derive(Clone, Copy)]
pub(crate) enum SqliteReadSnapshot {
    Checkpointed,
    SharedWal,
    RebuildWalIndex,
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
        let access = if write {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        } else {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        };
        self.connect(&self.path, access, busy, 1_048_576, false)
    }

    /// The caller confirms the source generation before and after using this snapshot.
    /// With no active WAL, immutable mode avoids materializing SQLite sidecar files.
    /// A WAL normally uses read-only shared memory. An uninitialized index
    /// can be reconstructed by SQLite without writing the database or WAL.
    pub fn open_read_snapshot(
        &self,
        mode: SqliteReadSnapshot,
        length_limit: i32,
    ) -> Result<Connection, SqliteFileError> {
        let mut uri = sqlite_uri_path(&self.path)?;
        uri.push_str(match mode {
            SqliteReadSnapshot::Checkpointed => "?mode=ro&immutable=1",
            SqliteReadSnapshot::SharedWal => "?mode=ro&readonly_shm=1",
            SqliteReadSnapshot::RebuildWalIndex => "?mode=ro",
        });
        self.connect(
            Path::new(&uri),
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
            Duration::ZERO,
            length_limit,
            true,
        )
    }

    fn connect(
        &self,
        path: &Path,
        flags: OpenFlags,
        busy: Duration,
        length_limit: i32,
        snapshot: bool,
    ) -> Result<Connection, SqliteFileError> {
        self.check_current()?;
        let c = Connection::open_with_flags(
            path,
            flags | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| SqliteFileError::Unavailable)?;
        // A rejected or rolled-back connection must not checkpoint a foreign WAL.
        c.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .map_err(|_| SqliteFileError::Unavailable)?;
        for (limit, value) in [
            (Limit::SQLITE_LIMIT_LENGTH, length_limit),
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
        if snapshot {
            c.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
                .map_err(|_| SqliteFileError::Unavailable)?;
            c.execute_batch("PRAGMA temp_store=MEMORY; BEGIN DEFERRED;")
                .map_err(|_| SqliteFileError::Unavailable)?;
        }
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

fn sqlite_uri_path(path: &Path) -> Result<String, SqliteFileError> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let mut uri = String::from("file:");
        for byte in path.as_os_str().as_bytes() {
            if *byte == b'/' {
                uri.push('/');
            } else {
                write!(uri, "%{byte:02X}").expect("writing to String is infallible");
            }
        }
        Ok(uri)
    }
    #[cfg(windows)]
    {
        let raw = path.to_str().ok_or(SqliteFileError::Unavailable)?;
        let stripped = raw
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!("//{rest}"))
            .or_else(|| raw.strip_prefix(r"\\?\").map(str::to_owned))
            .unwrap_or_else(|| raw.to_owned());
        let normalized = stripped.replace('\\', "/");
        let mut uri = String::from("file:/");
        for byte in normalized.trim_start_matches('/').as_bytes() {
            if *byte == b'/' {
                uri.push('/');
            } else if byte.is_ascii_alphanumeric() || matches!(*byte, b':' | b'-' | b'_' | b'.') {
                uri.push(*byte as char);
            } else {
                write!(uri, "%{byte:02X}").expect("writing to String is infallible");
            }
        }
        Ok(uri)
    }
}
