import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';

let root;
let repository;
let worktrees;
let artifacts;

function git(args, cwd = repository) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createRun(preset = 'work_in_workspace') {
  return {
    runId: 'run-1',
    automationId: 'automation-1',
    snapshot: {
      workspacePath: repository,
      grant: { preset },
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-automation-worktree-'));
  repository = path.join(root, 'repository');
  worktrees = path.join(root, 'worktrees');
  artifacts = path.join(root, 'artifacts');
  execFileSync('git', ['init', repository]);
  git(['config', 'user.email', 'automation@test.invalid']);
  git(['config', 'user.name', 'Automation Test']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('automation worktree adapter', () => {
  it('does not create a worktree for observe runs', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const execution = await adapter.prepare(createRun('observe'));
    assert.equal(execution.kind, 'workspace');
    assert.equal(execution.workspacePath, repository);
    assert.equal(existsSync(worktrees), false);
  });

  it('creates an isolated branch, records the baseline and retains changed worktrees', async () => {
    writeFileSync(path.join(repository, 'local-only.txt'), 'uncommitted\n');
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const run = createRun();
    const execution = await adapter.prepare(run);

    assert.equal(execution.kind, 'worktree');
    assert.equal(execution.baseline.commit, git(['rev-parse', 'HEAD']));
    assert.equal(execution.baseline.dirty, true);
    assert.equal(existsSync(path.join(execution.worktreePath, 'local-only.txt')), false);
    writeFileSync(path.join(execution.worktreePath, 'README.md'), 'changed\n');
    writeFileSync(path.join(execution.worktreePath, 'new.txt'), 'new\n');

    const changes = await adapter.collect(run, execution);
    assert.deepEqual(changes.changedFiles, ['README.md', 'new.txt']);
    assert.equal(changes.retained, true);
    assert.ok(changes.additions >= 2);
    assert.ok(changes.deletions >= 1);
    assert.match(readFileSync(path.join(artifacts, 'run-1', 'changes.patch'), 'utf8'), /README\.md/);
    assert.equal(await adapter.cleanup(run, execution), false);
    assert.equal(existsSync(execution.worktreePath), true);
  });

  it('cleans worktrees that produced no changes', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const run = createRun();
    const execution = await adapter.prepare(run);
    const changes = await adapter.collect(run, execution);
    const result = await adapter.retainOrCleanup(run, execution, changes);

    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.retained, false);
    assert.equal(existsSync(execution.worktreePath), false);
    assert.throws(() => git(['show-ref', '--verify', `refs/heads/${execution.branch}`]));
  });

  it('rejects non-Git write workspaces before running an agent', async () => {
    const plain = path.join(root, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    await assert.rejects(
      adapter.prepare({ ...createRun(), snapshot: { workspacePath: plain, grant: { preset: 'work_in_workspace' } } }),
      /automation_workspace_not_git/,
    );
  });

  it('treats a vanished workspace as missing instead of leaking ENOENT', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    await assert.rejects(
      adapter.inspectWorkspace(path.join(root, 'already-gone')),
      /automation_workspace_missing/,
    );
    await assert.rejects(
      adapter.prepare({
        ...createRun(),
        snapshot: { workspacePath: path.join(root, 'already-gone'), grant: { preset: 'work_in_workspace' } },
      }),
      /automation_workspace_missing/,
    );
  });

  it('collects and cleans an already-removed worktree without throwing', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const run = createRun();
    const execution = await adapter.prepare(run);
    rmSync(execution.worktreePath, { recursive: true, force: true });

    const changes = await adapter.collect(run, execution);
    assert.deepEqual(changes.changedFiles, []);
    assert.equal(changes.retained, false);

    const result = await adapter.retainOrCleanup(run, execution, changes);
    assert.equal(result.retained, false);
    assert.equal(existsSync(execution.worktreePath), false);
    assert.throws(() => git(['show-ref', '--verify', `refs/heads/${execution.branch}`]));
  });

  it('cleans a leftover directory whose .git is already gone', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const run = createRun();
    const execution = await adapter.prepare(run);
    rmSync(path.join(execution.worktreePath, '.git'), { recursive: true, force: true });
    writeFileSync(path.join(execution.worktreePath, 'orphan.txt'), 'left behind\n');

    const changes = await adapter.collect(run, execution);
    const result = await adapter.retainOrCleanup(run, execution, changes);

    assert.deepEqual(changes.changedFiles, []);
    assert.equal(result.retained, false);
    assert.equal(existsSync(execution.worktreePath), false);
    assert.throws(() => git(['show-ref', '--verify', `refs/heads/${execution.branch}`]));
  });

  it('can retainOrCleanup the same vanished worktree twice', async () => {
    const adapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const run = createRun();
    const execution = await adapter.prepare(run);
    const first = await adapter.retainOrCleanup(run, execution, { changedFiles: [] });
    const second = await adapter.retainOrCleanup(run, execution, { changedFiles: [] });

    assert.equal(first.retained, false);
    assert.equal(second.retained, false);
    assert.equal(existsSync(execution.worktreePath), false);
  });
});
