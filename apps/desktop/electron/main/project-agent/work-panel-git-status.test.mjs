import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkPanelGitRead } from '@peer-agent/runtime-node/git-read';
import { createWorkPanelGitStatus } from './work-panel-git-status.mjs';

const home = mkdtempSync(join(tmpdir(), 'peer-work-panel-git-home-'));
const gitConfigEnv = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
};
const fixtureGitEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
  ...gitConfigEnv,
};

// The reader intentionally strips inherited GIT_* variables. Isolate the config
// at the spawn boundary so system LFS filters cannot affect fixture observations.
const spawn = childProcess.spawn;
test.before(t => {
  const stub = t.mock.method(childProcess, 'spawn', (binary, args, options) =>
    spawn(binary, args, { ...options, env: { ...options.env, ...gitConfigEnv } }));
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
});
test.after(() => rmSync(home, { recursive: true, force: true }));

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-work-panel-git-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd: root, env: fixtureGitEnv, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
  }).trim();
  const put = (name, value = 'first\n') => writeFileSync(join(root, name), value);
  const init = () => {
    git('init', '-b', 'main');
    git('config', '--local', 'user.name', 'Peer');
    git('config', '--local', 'user.email', 'peer@example.invalid');
    git('config', '--local', 'commit.gpgSign', 'false');
    git('config', '--local', 'core.hooksPath', home);
  };
  const commit = () => git('commit', '-qm', 'fixture');
  const status = createWorkPanelGitStatus({ resolveWorkspacePath: id => id === 'child' ? join(root, 'nested') : root });
  return { root, git, put, init, commit, status };
}
const request = { workspaceId: 'bot' };

test('plain directory, unborn, clean and detached HEAD have distinct projections', async t => {
  const f = fixture(t);
  assert.equal((await f.status(request)).kind, 'not-git');
  f.init();
  const unborn = await f.status(request);
  assert.deepEqual([unborn.isGitRepo, unborn.branch, unborn.headShort, unborn.clean, unborn.unborn, unborn.detached], [true, 'main', null, true, true, false]);
  f.put('report.txt'); f.git('add', 'report.txt'); f.commit();
  const clean = await f.status(request);
  assert.deepEqual([clean.clean, clean.unborn, clean.changedCount, clean.totalEntries], [true, false, 0, 0]);
  f.git('checkout', '--detach', 'HEAD');
  const detached = await f.status(request);
  assert.deepEqual([detached.branch, detached.headShort, detached.detached, detached.unborn], [null, f.git('rev-parse', 'HEAD').slice(0, 8), true, false]);
});

test('nested workspace sees repository-relative mixed changes; only existing scoped files can open', async t => {
  const f = fixture(t);
  f.init(); mkdirSync(join(f.root, 'nested'));
  f.put('nested/文 档.txt'); f.put('nested/gone.txt'); f.put('outside.txt');
  f.git('add', '.'); f.commit();
  f.put('nested/文 档.txt', 'stage\n'); f.git('add', 'nested/文 档.txt');
  f.put('nested/文 档.txt', 'worktree\n'); f.put('nested/new.txt'); f.put('outside.txt', 'modified\n');
  unlinkSync(join(f.root, 'nested/gone.txt'));
  const indexPath = join(f.root, '.git/index');
  const before = readFileSync(indexPath);
  const status = await f.status({ workspaceId: 'child' });
  assert.equal(status.repoRoot, f.root);
  assert.deepEqual([status.clean, status.stagedCount, status.unstagedCount, status.untrackedCount, status.changedCount], [false, 1, 3, 1, 4]);
  assert.deepEqual(status.entries.map(e => [e.path, `${e.index}${e.worktree}`, e.openPath]), [
    ['nested/gone.txt', '.D', undefined], ['nested/文 档.txt', 'MM', '文 档.txt'], ['outside.txt', '.M', undefined], ['nested/new.txt', '??', 'new.txt'],
  ]);
  assert.deepEqual(readFileSync(indexPath), before);
  assert.equal(existsSync(`${indexPath}.lock`), false);
});

test('entry limit does not change totals; subprocess failures degrade without raw output', async t => {
  const f = fixture(t); f.init();
  for (let i = 0; i < 55; i++) f.put(`file-${i}.txt`);
  f.put('line\nbreak.txt');
  const result = await f.status(request);
  assert.deepEqual([result.entries.length, result.totalEntries, result.changedCount, result.untrackedCount, result.truncated], [50, 56, 56, 56, true]);
  for (const read of [createWorkPanelGitRead({ binary: join(f.root, 'missing-git') }), createWorkPanelGitRead({ maxBytes: 20 }), createWorkPanelGitRead({ timeoutMs: 0 })]) {
    const status = await createWorkPanelGitStatus({ resolveWorkspacePath: () => f.root, read })(request);
    assert.deepEqual(Object.keys(status).sort(), ['isGitRepo', 'kind', 'observedAt']);
    assert.equal(status.kind, 'unavailable');
  }
});

for (const initialFails of [false, true]) {
  test(`concurrent refreshes share one fresh observation after the active read ${initialFails ? 'fails' : 'succeeds'}`, async t => {
    const { root } = fixture(t);
    const first = Promise.withResolvers();
    const followUp = Promise.withResolvers();
    const observation = branch => ({ repositoryPath: root, workspacePath: root, filtersDisabled: false,
      records: `# branch.oid (initial)\0# branch.head ${branch}\0`, observedAt: new Date().toISOString() });
    const reads = [];
    const query = createWorkPanelGitStatus({
      resolveWorkspacePath: () => root,
      read: ({ path }) => {
        reads.push(path);
        if (reads.length === 1) return first.promise;
        if (reads.length === 2) return followUp.promise;
        return Promise.resolve(observation('after'));
      },
    });

    const active = query(request);
    const refreshA = query(request);
    const refreshB = query(request);
    assert.deepEqual(reads, [root]);

    if (initialFails) first.reject(new Error('read failed'));
    else first.resolve(observation('before'));
    const result = await active;
    assert.equal(result.kind, initialFails ? 'unavailable' : 'status');
    if (!initialFails) assert.equal(result.branch, 'before');
    assert.deepEqual(reads, [root, root]);

    followUp.resolve(observation('fresh'));
    const refreshes = await Promise.all([refreshA, refreshB]);
    assert.deepEqual(refreshes.map(({ kind, branch }) => [kind, branch]), [['status', 'fresh'], ['status', 'fresh']]);
    assert.deepEqual(reads, [root, root]);
    assert.equal((await query(request)).branch, 'after');
    assert.deepEqual(reads, [root, root, root]);
  });
}

test('configured clean filter and fsmonitor hook never execute', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t); f.init(); f.put('report.txt'); f.git('add', '.'); f.commit();
  f.put('.gitattributes', '*.txt filter=probe\n');
  f.git('config', 'filter.probe.clean', 'touch filter-executed; cat');
  f.git('config', 'core.fsmonitor', './monitor');
  writeFileSync(join(f.root, 'monitor'), '#!/bin/sh\ntouch monitor-executed\n', { mode: 0o755 });
  f.put('report.txt', 'new content\n');
  const status = await f.status(request);
  assert.equal(status.kind, 'status');
  assert.equal(status.filtersDisabled, true);
  assert.equal(existsSync(join(f.root, 'filter-executed')), false);
  assert.equal(existsSync(join(f.root, 'monitor-executed')), false);
});

test('unmerged paths retain both status codes without counting them as staged', async t => {
  const f = fixture(t); f.init(); f.put('report.txt'); f.git('add', '.'); f.commit();
  f.git('checkout', '-b', 'other'); f.put('report.txt', 'other\n'); f.git('add', '.'); f.commit();
  f.git('checkout', 'main'); f.put('report.txt', 'main\n'); f.git('add', '.'); f.commit();
  assert.throws(() => f.git('merge', 'other'), { status: 1 });
  const status = await f.status(request);
  assert.deepEqual([status.changedCount, status.stagedCount, status.unstagedCount], [1, 0, 0]);
  assert.deepEqual(status.entries[0], { path: 'report.txt', index: 'U', worktree: 'U', conflicted: true, openPath: 'report.txt' });
});
