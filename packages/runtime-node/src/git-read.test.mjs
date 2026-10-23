import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGitRead, validateGitReadQuery } from './git-read.mjs';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'peer-git-read-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim();
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  const file = path.join(root, 'tracked.txt'); writeFileSync(file, 'original\n'); git('add', '.'); git('commit', '-m', 'base');
  return { root, git, file, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
const observe = (query, root, input = {}) => query({ path: root, ...input }, { authorize: async () => {} });

test('observes clean, staged, unstaged, untracked and rename paths without updating index', async () => {
  const f = fixture();
  try {
    const query = createGitRead();
    const clean = await observe(query, f.root);
    assert.equal(clean.status.clean, clean.status.filtersDisabled ? null : true);
    f.git('mv', 'tracked.txt', 'renamed file.txt');
    writeFileSync(path.join(f.root, 'renamed file.txt'), 'changed\n');
    writeFileSync(path.join(f.root, 'new\tname.txt'), 'new');
    const index = readFileSync(path.join(f.root, '.git/index'));
    const observation = await observe(query, f.root);
    assert.equal(observation.status.clean, observation.status.filtersDisabled ? null : false); assert.equal(observation.status.untracked, 1);
    assert.ok(observation.status.entries.some(row => row.path === 'renamed file.txt' && row.from === 'tracked.txt'));
    assert.ok(observation.status.entries.some(row => row.path === 'new\tname.txt'));
    assert.deepEqual(readFileSync(path.join(f.root, '.git/index')), index);
    assert.equal(existsSync(path.join(f.root, '.git/index.lock')), false);
    assert.equal(observation.head, f.git('rev-parse', 'HEAD')); assert.equal(observation.atomic, false);
  } finally { f.dispose(); }
});

test('detached and unborn repositories remain explicit', async () => {
  const f = fixture();
  try {
    f.git('checkout', '--detach');
    const detached = await observe(createGitRead(), f.root);
    assert.equal(detached.branch, null); assert.equal(detached.unborn, false);
    const empty = path.join(f.root, 'empty'); mkdirSync(empty); execFileSync('git', ['init', empty]);
    const unborn = await observe(createGitRead(), empty);
    assert.equal(unborn.head, null); assert.equal(unborn.unborn, true); assert.deepEqual(unborn.commits, []);
  } finally { f.dispose(); }
});

test('worktrees authorize their actual shared Git directory and redact origin credentials', async () => {
  const f = fixture();
  try {
    const worktree = path.join(f.root, 'linked'); f.git('worktree', 'add', '--detach', worktree);
    f.git('config', 'remote.origin.url', 'https://user:private-token@example.invalid/repo?access_token=secret');
    const admitted = [];
    const result = await createGitRead()({ path: worktree }, { authorize: async directory => admitted.push(directory) });
    assert.ok(admitted.includes(path.join(f.root, '.git')));
    assert.equal(result.commonDirectory, path.join(f.root, '.git'));
    assert.doesNotMatch(JSON.stringify(result.origin), /private-token|=secret/);
  } finally { f.dispose(); }
});

test('rejects shell/config/argument injection and missing Git without claiming a permission failure', async () => {
  for (const input of [{ path: '.', command: 'touch x' }, { path: '.', env: {} }, { path: '.', operation: 'fetch' },
    { path: '.', limit: 201 }, { path: '.', revision: '--exec=touch x' }]) assert.throws(() => validateGitReadQuery(input));
  await assert.rejects(observe(createGitRead({ binary: path.join(tmpdir(), 'peer-nonexistent-git-executable') }), tmpdir()), { reason: 'git_unavailable' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGitRead()({ path: tmpdir() }, { signal: controller.signal, authorize: async () => {} }), { reason: 'git_query_cancelled' });
});

test('repository clean/process filters and fsmonitor cannot execute during status', async () => {
  const f = fixture();
  try {
    const marker = path.join(f.root, 'UNEXPECTED_EXECUTION');
    f.git('config', 'filter.hostile.clean', `touch '${marker}'`);
    f.git('config', 'filter.hostile.process', `touch '${marker}'`);
    f.git('config', 'filter.hostile.required', 'true');
    f.git('config', 'core.fsmonitor', `touch '${marker}'`);
    writeFileSync(path.join(f.root, '.gitattributes'), '*.txt filter=hostile\n'); writeFileSync(f.file, 'changed');
    const result = await observe(createGitRead(), f.root);
    assert.equal(result.status.clean, null); assert.equal(result.status.filtersDisabled, true); assert.equal(existsSync(marker), false);
  } finally { f.dispose(); }
});

test('uninspected submodules never produce a false clean claim', async () => {
  const f = fixture(), dependency = fixture();
  try {
    f.git('-c', 'protocol.file.allow=always', 'submodule', 'add', dependency.root, 'dependency');
    f.git('commit', '-m', 'add submodule');
    writeFileSync(path.join(f.root, 'dependency/tracked.txt'), 'uncommitted');
    const result = await observe(createGitRead(), f.root);
    assert.equal(result.status.submoduleCount, 1); assert.equal(result.status.submodulesInspected, false);
    assert.equal(result.status.clean, null);
  } finally { f.dispose(); dependency.dispose(); }
});

test('output and elapsed-time limits fail explicitly rather than returning clean partial state', async () => {
  const f = fixture();
  try {
    await assert.rejects(observe(createGitRead({ maxBytes: 1 }), f.root), { reason: 'git_query_output_limit' });
    await assert.rejects(observe(createGitRead({ timeoutMs: 0 }), f.root), { reason: 'git_query_timeout' });
  } finally { f.dispose(); }
});
