import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathOf } from '@peer-agent/runtime-node';

const execFileAsync = promisify(execFile);

function safeSegment(value, fallback) {
  const result = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return result || fallback;
}

async function defaultRunGit(args, { cwd }) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function parsePorcelainZ(output) {
  if (!output) return [];
  const values = output.split('\0').filter(Boolean);
  const files = [];
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (file) files.push(file);
    if ((status.startsWith('R') || status.startsWith('C')) && values[index + 1]) {
      files.push(values[index + 1]);
      index += 1;
    }
  }
  return [...new Set(files)].sort();
}

function parseNumstat(output) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added)) additions += Number(added);
    if (/^\d+$/.test(deleted)) deletions += Number(deleted);
  }
  return { additions, deletions };
}

/** Owns Git worktree creation, evidence collection, retention and cleanup for Automation Runs. */
export function createAutomationWorktreeAdapter({
  rootDir = path.join(pathOf('automations'), 'worktrees'),
  artifactDir = path.join(pathOf('automations'), 'artifacts'),
  runGit = defaultRunGit,
} = {}) {
  const prepared = new Map();

  async function inspectWorkspace(workspacePath) {
    const info = await stat(workspacePath);
    if (!info.isDirectory()) throw new Error('automation_workspace_not_directory');
    let repositoryRoot;
    try {
      repositoryRoot = (await runGit(['rev-parse', '--show-toplevel'], { cwd: workspacePath })).stdout.trim();
    } catch {
      throw new Error('automation_workspace_not_git');
    }
    const commit = (await runGit(['rev-parse', 'HEAD'], { cwd: repositoryRoot })).stdout.trim();
    if (!commit) throw new Error('automation_git_baseline_invalid');
    const branch = (await runGit(['branch', '--show-current'], { cwd: repositoryRoot })).stdout.trim() || undefined;
    const dirty = Boolean((await runGit(['status', '--porcelain'], { cwd: repositoryRoot })).stdout.trim());
    return { repositoryRoot, commit, branch, dirty };
  }

  async function prepare(run) {
    if (run.snapshot.grant.preset === 'observe') {
      await stat(run.snapshot.workspacePath);
      return {
        kind: 'workspace',
        workspacePath: run.snapshot.workspacePath,
        baseline: null,
      };
    }
    const baseline = await inspectWorkspace(run.snapshot.workspacePath);
    const runSegment = safeSegment(run.runId, 'run');
    const automationSegment = safeSegment(run.automationId, 'automation');
    const worktreePath = path.join(rootDir, automationSegment, runSegment);
    const branch = `PeerAgent/automation-${automationSegment}/run-${runSegment}`;
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await rm(worktreePath, { recursive: true, force: true });
    try {
      await runGit(['worktree', 'add', '-b', branch, worktreePath, baseline.commit], {
        cwd: baseline.repositoryRoot,
      });
    } catch (error) {
      throw new Error(`automation_worktree_create_failed:${error?.message || error}`);
    }
    const execution = {
      kind: 'worktree',
      workspacePath: worktreePath,
      repositoryRoot: baseline.repositoryRoot,
      worktreePath,
      branch,
      baseline: {
        commit: baseline.commit,
        branch: baseline.branch,
        dirty: baseline.dirty,
      },
    };
    prepared.set(run.runId, execution);
    return execution;
  }

  async function collect(run, execution = prepared.get(run.runId)) {
    if (!execution || execution.kind !== 'worktree') return null;
    const status = await runGit(['status', '--porcelain=v1', '-z'], { cwd: execution.worktreePath });
    const changedFiles = parsePorcelainZ(status.stdout);
    if (!changedFiles.length) {
      return {
        worktreePath: execution.worktreePath,
        branch: execution.branch,
        changedFiles: [],
        additions: 0,
        deletions: 0,
        diffArtifactRefs: [],
        retained: false,
      };
    }

    // Intent-to-add makes untracked files visible to git diff without creating a commit.
    await runGit(['add', '--intent-to-add', '--all'], { cwd: execution.worktreePath });
    const [diff, numstat] = await Promise.all([
      runGit(['diff', '--binary', '--no-ext-diff', 'HEAD'], { cwd: execution.worktreePath }),
      runGit(['diff', '--numstat', 'HEAD'], { cwd: execution.worktreePath }),
    ]);
    const runArtifactDir = path.join(artifactDir, safeSegment(run.runId, 'run'));
    const diffPath = path.join(runArtifactDir, 'changes.patch');
    await mkdir(runArtifactDir, { recursive: true });
    await writeFile(diffPath, diff.stdout, 'utf8');
    const totals = parseNumstat(numstat.stdout);
    return {
      worktreePath: execution.worktreePath,
      branch: execution.branch,
      changedFiles,
      ...totals,
      diffArtifactRefs: [`automation-artifact://${encodeURIComponent(run.runId)}/changes.patch`],
      retained: true,
    };
  }

  async function cleanup(run, execution = prepared.get(run.runId), { force = false } = {}) {
    if (!execution || execution.kind !== 'worktree') return false;
    if (!force) {
      const status = await runGit(['status', '--porcelain'], { cwd: execution.worktreePath });
      if (status.stdout.trim()) return false;
    }
    await runGit(['worktree', 'remove', '--force', execution.worktreePath], {
      cwd: execution.repositoryRoot,
    });
    await runGit(['branch', '-D', execution.branch], { cwd: execution.repositoryRoot });
    prepared.delete(run.runId);
    return true;
  }

  async function retainOrCleanup(run, execution, changes) {
    if (!execution || execution.kind !== 'worktree') return changes;
    if (changes?.changedFiles?.length) return { ...changes, retained: true };
    await cleanup(run, execution, { force: true });
    return changes ? { ...changes, retained: false } : null;
  }

  return Object.freeze({ inspectWorkspace, prepare, collect, cleanup, retainOrCleanup });
}
