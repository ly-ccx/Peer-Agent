//! Workspace file hash anchoring (`packages/runtime-node/src/memory/file-anchors.mjs`).

use crate::memory::MemoryFileAnchor;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path},
    process::Command,
};

const MAX_ANCHOR_BYTES: u64 = 1024 * 1024;
const MAX_ANCHORS: usize = 16;

fn read_git_commit(root: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    (!sha.is_empty()).then_some(sha)
}

/// Capture content SHA-256 and optional git commit for a workspace-relative file (`<= 1 MiB`).
pub fn read_file_anchor(workspace_path: &Path, relative_path: &str) -> Option<MemoryFileAnchor> {
    if relative_path.is_empty() || relative_path.contains('\\') || relative_path.starts_with('/') {
        return None;
    }
    let rel_check = Path::new(relative_path);
    if rel_check.is_absolute()
        || rel_check.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    let root = fs::canonicalize(workspace_path).ok()?;
    let target = fs::canonicalize(root.join(relative_path)).ok()?;
    let rel = target.strip_prefix(&root).ok()?;
    let rel_str = rel
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if rel_str.is_empty() {
        return None;
    }
    let meta = fs::metadata(&target).ok()?;
    if !meta.is_file() || meta.len() > MAX_ANCHOR_BYTES {
        return None;
    }
    let bytes = fs::read(&target).ok()?;
    if bytes.len() as u64 > MAX_ANCHOR_BYTES {
        return None;
    }
    let content_hash = format!("{:x}", Sha256::digest(&bytes));
    Some(MemoryFileAnchor {
        path: rel_str,
        content_hash,
        commit: read_git_commit(&root),
    })
}

pub fn capture_file_anchors(workspace_path: &Path, paths: &[String]) -> Vec<MemoryFileAnchor> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in paths {
        if !seen.insert(raw.as_str()) {
            continue;
        }
        if let Some(anchor) = read_file_anchor(workspace_path, raw) {
            out.push(anchor);
            if out.len() >= MAX_ANCHORS {
                break;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_file_anchor_hashes_workspace_files_and_rejects_escapes() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("src")).unwrap();
        fs::write(dir.path().join("src/cfg.rs"), b"const PG: u8 = 16;\n").unwrap();

        let a = read_file_anchor(dir.path(), "src/cfg.rs").expect("valid anchor");
        assert_eq!(a.path, "src/cfg.rs");
        assert_eq!(a.content_hash.len(), 64);

        assert!(read_file_anchor(dir.path(), "../escape.txt").is_none());
        assert!(read_file_anchor(dir.path(), "/etc/passwd").is_none());
        assert!(read_file_anchor(dir.path(), "src\\cfg.rs").is_none());
    }
}
