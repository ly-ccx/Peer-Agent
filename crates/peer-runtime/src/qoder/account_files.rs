use crate::{CancellationToken, model::ModelError};
use std::{
    fs::{File, Metadata},
    io::Read,
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
#[derive(PartialEq, Eq)]
struct Version {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}
fn version(meta: &Metadata) -> Version {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Version {
            dev: meta.dev(),
            ino: meta.ino(),
            size: meta.len(),
            mtime_ns: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            ctime_ns: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Version {
            dev: u64::from(meta.file_attributes()),
            ino: meta.creation_time(),
            size: meta.len(),
            mtime_ns: i128::from(meta.last_write_time()),
            ctime_ns: i128::from(meta.creation_time()),
        }
    }
}
fn error(e: std::io::Error) -> ModelError {
    ModelError::new(match e.kind() {
        std::io::ErrorKind::NotFound => "qoder_auth_not_found",
        std::io::ErrorKind::PermissionDenied => "qoder_auth_permission_denied",
        _ => "qoder_auth_unavailable",
    })
}
pub(super) struct Observation {
    path: PathBuf,
    before: Version,
}
#[derive(Default)]
pub(super) struct ReadSet {
    files: Vec<Observation>,
    absent: Vec<PathBuf>,
}
impl ReadSet {
    pub fn required(
        &mut self,
        path: &Path,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Zeroizing<Vec<u8>>, ModelError> {
        let (bytes, observation) = read(path, limit, cancel)?;
        self.files.push(observation);
        Ok(bytes)
    }
    pub fn optional(
        &mut self,
        path: &Path,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, ModelError> {
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.absent.push(path.into());
                Ok(None)
            }
            Err(e) => Err(error(e)),
            Ok(_) => self.required(path, limit, cancel).map(Some),
        }
    }
    pub fn validate(&self) -> Result<(), ModelError> {
        for file in &self.files {
            file.validate()?;
        }
        for path in &self.absent {
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(ModelError::new("qoder_auth_changed")),
            }
        }
        Ok(())
    }
}
impl Observation {
    pub fn validate(&self) -> Result<(), ModelError> {
        let m = std::fs::symlink_metadata(&self.path)
            .map_err(|_| ModelError::new("qoder_auth_changed"))?;
        if !m.is_file() || version(&m) != self.before {
            return Err(ModelError::new("qoder_auth_changed"));
        }
        Ok(())
    }
}
pub(super) fn read(
    path: &Path,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<(Zeroizing<Vec<u8>>, Observation), ModelError> {
    if cancel.is_cancelled() {
        return Err(ModelError::new("CANCELLED"));
    }
    let before = std::fs::symlink_metadata(path).map_err(error)?;
    if !before.is_file() {
        return Err(ModelError::new("qoder_auth_not_regular"));
    }
    if before.len() > limit as u64 {
        return Err(ModelError::new("qoder_auth_limit"));
    }
    #[cfg(unix)]
    let mut file = {
        let fd = rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::CLOEXEC
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::NOCTTY,
            rustix::fs::Mode::empty(),
        )
        .map_err(|e| error(e.into()))?;
        File::from(fd)
    };
    #[cfg(windows)]
    let mut file = {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(error)?;
        let opened_meta = file.metadata().map_err(error)?;
        if (opened_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
            return Err(ModelError::new("qoder_auth_not_regular"));
        }
        file
    };
    let identity = version(&before);
    if version(&file.metadata().map_err(error)?) != identity {
        return Err(ModelError::new("qoder_auth_changed"));
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut buffer = Zeroizing::new([0u8; 16384]);
    while bytes.len() < (identity.size as usize) {
        if cancel.is_cancelled() {
            return Err(ModelError::new("CANCELLED"));
        }
        let take = (identity.size as usize - bytes.len()).min(buffer.len());
        let n = file.read(&mut buffer[..take]).map_err(error)?;
        if n == 0 {
            return Err(ModelError::new("qoder_auth_changed"));
        }
        bytes.extend_from_slice(&buffer[..n]);
    }
    let observation = Observation {
        path: path.into(),
        before: identity,
    };
    observation.validate()?;
    if version(&file.metadata().map_err(error)?) != observation.before {
        return Err(ModelError::new("qoder_auth_changed"));
    }
    if cancel.is_cancelled() {
        return Err(ModelError::new("CANCELLED"));
    }
    Ok((bytes, observation))
}
