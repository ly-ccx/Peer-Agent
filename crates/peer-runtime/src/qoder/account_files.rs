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
    mtime: (i64, i64),
    ctime: (i64, i64),
}
fn version(meta: &Metadata) -> Version {
    use std::os::unix::fs::MetadataExt;
    Version {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.len(),
        mtime: (meta.mtime(), meta.mtime_nsec()),
        ctime: (meta.ctime(), meta.ctime_nsec()),
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
    let mut file = File::from(fd);
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
