//! Publication of the existing local-shell-artifact files through owned FDs.
use rustix::fs::{self, AtFlags, FileType, Mode, OFlags};
use serde_json::Value;
use std::{
    fs::File,
    io::{self, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

const ROOT: &str = "shell-artifacts";
const STDOUT: &str = "stdout.txt";
const STDERR: &str = "stderr.txt";
const METADATA: &str = "metadata.json";
type Identity = (u64, u64);

pub struct ShellArtifacts {
    home_path: PathBuf,
    home: File,
    root: File,
    day: String,
    date: File,
    id: String,
    task: File,
    stdout: Identity,
    stderr: Identity,
    metadata: Identity,
}

impl ShellArtifacts {
    pub fn begin(
        home: &Path,
        started_at: &str,
        id: &str,
        metadata: &Value,
    ) -> io::Result<(Self, File, File)> {
        let day = started_at.get(..10).ok_or_else(invalid)?;
        let valid_day = day.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 4 | 7) {
                byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        });
        let task_id = id
            .strip_prefix("shell_")
            .filter(|s| s.len() == 36)
            .and_then(|s| uuid::Uuid::parse_str(s).ok());
        if !valid_day || task_id.is_none() {
            return Err(invalid());
        }
        let home_path = home.to_owned();
        let home = File::from(fs::open(
            home,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        let root = create_directory(&home, ROOT, true)?;
        let date = create_directory(&root, day, true)?;
        let task = create_directory(&date, id, false)?;
        let stdout = create_file(&task, STDOUT)?;
        let stderr = create_file(&task, STDERR)?;
        let initial = write_metadata(&task, METADATA, metadata)?;
        task.sync_all()?;
        let initialized = Self {
            home_path,
            home,
            root,
            day: day.into(),
            date,
            id: id.into(),
            task,
            stdout: identity(&stdout)?,
            stderr: identity(&stderr)?,
            metadata: initial,
        };
        initialized.check_current()?;
        Ok((initialized, stdout, stderr))
    }

    pub fn check_current(&self) -> io::Result<()> {
        let current = std::fs::symlink_metadata(&self.home_path)?;
        if !current.is_dir() || (current.dev(), current.ino()) != identity(&self.home)? {
            return Err(invalid());
        }
        for (parent, name, child) in [
            (&self.home, ROOT, &self.root),
            (&self.root, self.day.as_str(), &self.date),
            (&self.date, self.id.as_str(), &self.task),
        ] {
            check_at(parent, name, identity(child)?, FileType::Directory)?;
        }
        for (name, saved) in [
            (STDOUT, self.stdout),
            (STDERR, self.stderr),
            (METADATA, self.metadata),
        ] {
            check_at(&self.task, name, saved, FileType::RegularFile)?;
        }
        Ok(())
    }

    /// The Provider must join both output writers before sealing metadata.
    pub fn finish(&mut self, metadata: &Value) -> io::Result<()> {
        const NEXT: &str = "metadata.next";
        self.check_current()?;
        let prepared = write_metadata(&self.task, NEXT, metadata)?;
        check_at(&self.task, NEXT, prepared, FileType::RegularFile)?;
        self.check_current()?;
        fs::renameat(&self.task, NEXT, &self.task, METADATA)?;
        self.metadata = prepared;
        self.task.sync_all()?;
        self.check_current()
    }
}

fn invalid() -> io::Error {
    io::Error::other("shell_artifact_unavailable")
}

fn identity(file: &File) -> io::Result<Identity> {
    let meta = file.metadata()?;
    Ok((meta.dev(), meta.ino()))
}

fn check_at(parent: &File, name: &str, expected: Identity, kind: FileType) -> io::Result<()> {
    let stat = fs::statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)?;
    if i128::from(stat.st_dev) != i128::from(expected.0)
        || i128::from(stat.st_ino) != i128::from(expected.1)
        || FileType::from_raw_mode(stat.st_mode) != kind
        || kind == FileType::RegularFile && stat.st_nlink != 1
    {
        return Err(invalid());
    }
    Ok(())
}

fn create_directory(parent: &File, name: &str, shared: bool) -> io::Result<File> {
    match fs::mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
        Ok(()) => parent.sync_all()?,
        Err(rustix::io::Errno::EXIST) if shared => (),
        Err(error) => return Err(error.into()),
    }
    Ok(File::from(fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )?))
}

fn create_file(parent: &File, name: &str) -> io::Result<File> {
    Ok(File::from(fs::openat(
        parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )?))
}

fn write_metadata(parent: &File, name: &str, metadata: &Value) -> io::Result<Identity> {
    let mut file = create_file(parent, name)?;
    serde_json::to_writer(&mut file, metadata)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    identity(&file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn finish_rejects_changed_artifact_paths_and_preserves_unowned_files() {
        let home = tempfile::tempdir().unwrap();
        let start = "2026-11-18T00:00:00.000Z";
        let task = "shell_239cc372-7880-4d2e-8e8f-2a1b9bb111a7";
        let (mut writer, mut out, _) =
            ShellArtifacts::begin(home.path(), start, task, &json!({"status":"running"})).unwrap();
        assert!(ShellArtifacts::begin(home.path(), start, task, &json!({})).is_err());
        let directory = home.path().join(ROOT).join("2026-11-18").join(task);
        let unrelated = home.path().join("unrelated");
        std::fs::write(&unrelated, b"independent").unwrap();
        let previous = directory.join("saved-stdout");
        std::fs::rename(directory.join(STDOUT), &previous).unwrap();
        std::os::unix::fs::symlink(&unrelated, directory.join(STDOUT)).unwrap();
        out.write_all(b"observed").unwrap();
        assert!(writer.finish(&json!({"status":"success"})).is_err());
        assert_eq!(std::fs::read(&previous).unwrap(), b"observed");
        assert_eq!(std::fs::read(&unrelated).unwrap(), b"independent");
        let current: Value =
            serde_json::from_reader(File::open(directory.join(METADATA)).unwrap()).unwrap();
        assert_eq!(current["status"], "running");
    }
}
