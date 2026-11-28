//! Git worktree and task-branch isolation adapter for parallel delegated write sessions.
//!
//! Matches `packages/runtime-node/src/project-agent/goal-worktree-adapter.mjs` (ADR 68, ADR 79, ADR 80):
//! - Stores isolated worktrees under `<data_home>/goal-plans/worktrees/<planId>/`.
//! - Binds target branch to live workspace HEAD at spawn time (ADR 79).
//! - Never force-merges dirty workspaces or pushes to remotes automatically.

use crate::ProjectError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeHandle {
    pub workspace_path: PathBuf,
    pub worktree_path: PathBuf,
    pub repository_root: PathBuf,
    pub branch: String,
    pub target_branch: String,
    pub baseline_commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffOutcome {
    Merged {
        commit_sha: String,
    },
    NothingToMerge,
    Stopped {
        reason: &'static str,
        detail: String,
    },
}

fn safe_segment(value: &str, fallback: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    let clipped: String = trimmed.chars().take(48).collect();
    if clipped.is_empty() {
        fallback.to_owned()
    } else {
        clipped
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, ProjectError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| ProjectError::new("GIT_ERROR", e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(ProjectError::new(
            "GIT_ERROR",
            if stderr.is_empty() {
                format!("git {} exited {}", args.join(" "), output.status)
            } else {
                stderr
            },
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub struct GoalWorktreeAdapter {
    worktrees_root: PathBuf,
    branch_prefix: String,
}

impl GoalWorktreeAdapter {
    pub fn new(data_home: impl AsRef<Path>, branch_prefix: Option<&str>) -> Self {
        let prefix = branch_prefix
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("PeerAgent");
        Self {
            worktrees_root: data_home.as_ref().join("goal-plans").join("worktrees"),
            branch_prefix: prefix.trim_end_matches('/').to_owned(),
        }
    }

    pub fn worktree_dir(&self, plan_id: &str) -> PathBuf {
        let seg = safe_segment(plan_id, "plan");
        self.worktrees_root.join(&seg).join(&seg)
    }

    pub fn is_git_repository(workspace: &Path) -> bool {
        run_git(workspace, &["rev-parse", "--is-inside-work-tree"])
            .map(|s| s == "true")
            .unwrap_or(false)
    }

    /// Create or attach an isolated git worktree for `plan_id` branched from current HEAD.
    pub fn prepare(
        &self,
        plan_id: &str,
        workspace: &Path,
        slug: Option<&str>,
    ) -> Result<WorktreeHandle, ProjectError> {
        let repo_root = PathBuf::from(run_git(workspace, &["rev-parse", "--show-toplevel"])?);
        let baseline = run_git(&repo_root, &["rev-parse", "HEAD"])?;
        let target_branch = run_git(&repo_root, &["symbolic-ref", "--short", "HEAD"])
            .unwrap_or_else(|_| baseline.clone());
        let branch_seg = safe_segment(slug.unwrap_or(plan_id), "task");
        let branch = format!("{}/task/{branch_seg}", self.branch_prefix);
        let wt_path = self.worktree_dir(plan_id);

        if wt_path.join(".git").exists() {
            return Ok(WorktreeHandle {
                workspace_path: workspace.to_path_buf(),
                worktree_path: wt_path,
                repository_root: repo_root,
                branch,
                target_branch,
                baseline_commit: baseline,
            });
        }
        if let Some(parent) = wt_path.parent() {
            fs::create_dir_all(parent).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let wt_str = wt_path.to_string_lossy().into_owned();
        let branch_exists = run_git(
            &repo_root,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .is_ok();
        if branch_exists {
            run_git(&repo_root, &["worktree", "add", &wt_str, &branch])?;
        } else {
            run_git(
                &repo_root,
                &["worktree", "add", "-b", &branch, &wt_str, &baseline],
            )?;
        }
        Ok(WorktreeHandle {
            workspace_path: workspace.to_path_buf(),
            worktree_path: wt_path,
            repository_root: repo_root,
            branch,
            target_branch,
            baseline_commit: baseline,
        })
    }

    /// Lists changed paths in a worktree relative to its baseline commit (staged, committed, or working).
    pub fn changed_files(&self, handle: &WorktreeHandle) -> Vec<String> {
        let mut files = Vec::new();
        if let Ok(committed) = run_git(
            &handle.worktree_path,
            &[
                "diff",
                "--name-only",
                &format!("{}..HEAD", handle.baseline_commit),
            ],
        ) {
            files.extend(
                committed
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(str::to_owned),
            );
        }
        if let Ok(status) = run_git(&handle.worktree_path, &["status", "--porcelain"]) {
            for line in status.lines() {
                if line.len() > 3 {
                    let path = line[3..].trim().to_owned();
                    if !path.is_empty() && !files.contains(&path) {
                        files.push(path);
                    }
                }
            }
        }
        files
    }

    /// Safely merge the worktree task branch into the target workspace branch only when
    /// target workspace is clean and on `target_branch`. Never auto-pushes or force-merges.
    pub fn handoff_merge(&self, handle: &WorktreeHandle) -> Result<HandoffOutcome, ProjectError> {
        let wt_dirty = run_git(&handle.worktree_path, &["status", "--porcelain"])?;
        if !wt_dirty.is_empty() {
            return Ok(HandoffOutcome::Stopped {
                reason: "worktree_dirty",
                detail: "task worktree has uncommitted changes".to_owned(),
            });
        }
        let task_head = run_git(&handle.worktree_path, &["rev-parse", "HEAD"])?;
        if task_head == handle.baseline_commit {
            return Ok(HandoffOutcome::NothingToMerge);
        }
        let target_dirty = run_git(&handle.repository_root, &["status", "--porcelain"])?;
        if !target_dirty.is_empty() {
            return Ok(HandoffOutcome::Stopped {
                reason: "target_workspace_dirty",
                detail: "target workspace has uncommitted changes".to_owned(),
            });
        }
        let current_branch = run_git(
            &handle.repository_root,
            &["symbolic-ref", "--short", "HEAD"],
        )
        .unwrap_or_default();
        if current_branch != handle.target_branch {
            return Ok(HandoffOutcome::Stopped {
                reason: "target_branch_changed",
                detail: format!(
                    "expected branch {}, currently on {}",
                    handle.target_branch, current_branch
                ),
            });
        }
        match run_git(
            &handle.repository_root,
            &["merge", "--no-edit", &handle.branch],
        ) {
            Ok(_) => {
                let sha = run_git(&handle.repository_root, &["rev-parse", "HEAD"])?;
                Ok(HandoffOutcome::Merged { commit_sha: sha })
            }
            Err(err) => {
                let _ = run_git(&handle.repository_root, &["merge", "--abort"]);
                Ok(HandoffOutcome::Stopped {
                    reason: "merge_conflict",
                    detail: err.detail,
                })
            }
        }
    }

    /// Remove worktree only if clean; dirty worktrees are preserved for recovery.
    pub fn cleanup_if_clean(&self, handle: &WorktreeHandle) -> Result<bool, ProjectError> {
        if !handle.worktree_path.exists() {
            return Ok(true);
        }
        let status = run_git(&handle.worktree_path, &["status", "--porcelain"]).unwrap_or_default();
        if !status.is_empty() {
            return Ok(false);
        }
        let wt_str = handle.worktree_path.to_string_lossy().into_owned();
        run_git(&handle.repository_root, &["worktree", "remove", &wt_str])?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn worktree_prepare_detect_changes_merge_and_cleanup() {
        let dir = tempdir().unwrap();
        let repo = dir.path().join("repo");
        let home = dir.path().join("home");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-b", "main"]).unwrap();
        run_git(&repo, &["config", "user.email", "test@example.com"]).unwrap();
        run_git(&repo, &["config", "user.name", "Test"]).unwrap();
        fs::write(repo.join("README.md"), "hello\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["commit", "-m", "init"]).unwrap();

        let adapter = GoalWorktreeAdapter::new(&home, Some("PeerAgent"));
        let handle = adapter.prepare("plan-123", &repo, Some("fix-one")).unwrap();
        assert!(handle.worktree_path.join("README.md").exists());

        fs::write(handle.worktree_path.join("new.txt"), "data\n").unwrap();
        assert_eq!(adapter.changed_files(&handle), vec!["new.txt"]);
        run_git(&handle.worktree_path, &["add", "new.txt"]).unwrap();
        run_git(&handle.worktree_path, &["commit", "-m", "add new"]).unwrap();

        let merged = adapter.handoff_merge(&handle).unwrap();
        assert!(matches!(merged, HandoffOutcome::Merged { .. }));
        assert!(repo.join("new.txt").exists());
        assert!(adapter.cleanup_if_clean(&handle).unwrap());
    }
}
