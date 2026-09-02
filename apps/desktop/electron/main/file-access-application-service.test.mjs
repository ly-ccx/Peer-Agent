import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFileAccessApplicationService } from './file-access-application-service.mjs';

class FakeWatcher extends EventEmitter {
  constructor(onChange) {
    super();
    this.onChange = onChange;
    this.closeCount = 0;
  }

  close() {
    this.closeCount += 1;
  }
}

class FakeSender extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.destroyed = false;
    this.messages = [];
  }

  isDestroyed() {
    return this.destroyed;
  }

  send(channel, payload) {
    this.messages.push([channel, payload]);
  }

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

function file(content) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return { kind: 'file', buffer, size: buffer.length };
}

function directory(entries = []) {
  return { kind: 'directory', entries };
}

function createHarness(overrides = {}) {
  const nodes = new Map(overrides.nodes ?? [
    ['/ws-a', directory()],
    ['/ws-b', directory()],
  ]);
  const settings = overrides.settings ?? {
    workspaces: [{ path: '/ws-a' }, { path: '/ws-b' }],
    activeWorkspace: '/ws-a',
  };
  const gitCalls = [];
  const watchers = [];
  const written = [];
  const created = [];

  const service = createFileAccessApplicationService({
    getSettings: () => settings,
    pathExists: (candidate) => nodes.has(candidate),
    statPath: (candidate) => {
      const node = nodes.get(candidate);
      if (!node) throw new Error(`ENOENT: ${candidate}`);
      return {
        size: node.size ?? 0,
        isDirectory: () => node.kind === 'directory',
        isFile: () => node.kind === 'file',
      };
    },
    readDirectory: (candidate) => {
      const node = nodes.get(candidate);
      if (!node || node.kind !== 'directory') throw new Error('ENOTDIR');
      return node.entries.map((entry) => ({
        name: entry.name,
        isDirectory: () => entry.isDir,
      }));
    },
    readFile: (candidate) => {
      const node = nodes.get(candidate);
      if (!node || node.kind !== 'file') throw new Error('ENOENT');
      return node.buffer;
    },
    writeFile: (candidate, content) => {
      written.push([candidate, content]);
      nodes.set(candidate, file(Buffer.from(String(content ?? ''), 'utf8')));
    },
    createDirectory: (candidate) => {
      created.push(candidate);
      nodes.set(candidate, directory());
    },
    watchDirectory: (candidate, options, onChange) => {
      if (overrides.watchErrorPaths?.has(candidate)) throw new Error('watch_failed');
      const watcher = new FakeWatcher(onChange);
      watcher.path = candidate;
      watcher.options = options;
      watchers.push(watcher);
      return watcher;
    },
    executeGit: async (cwd, args, options) => {
      gitCalls.push([cwd, args, options]);
      if (overrides.executeGit) return overrides.executeGit(cwd, args, options);
      throw new Error('git_not_configured');
    },
  });

  return { service, nodes, gitCalls, watchers, written, created };
}

test('exists and read-directory recover by relative path across known workspaces', () => {
  const harness = createHarness({
    nodes: [
      ['/ws-a', directory()],
      ['/ws-b', directory()],
      ['/ws-b/src', directory([
        { name: 'zeta.txt', isDir: false },
        { name: 'alpha', isDir: true },
        { name: 'Beta.txt', isDir: false },
      ])],
    ],
  });

  assert.deepEqual(harness.service.exists({
    absPath: '/stale/src',
    workspaceRoot: '/stale',
    relPath: '/src',
  }), {
    exists: true,
    isDir: true,
    resolvedFrom: '/ws-b',
  });
  assert.deepEqual(harness.service.readDirectory({
    absPath: '/stale/src',
    workspaceRoot: '/stale',
    relPath: '../src',
  }), {
    ok: true,
    status: 'ok',
    entries: [
      { name: 'alpha', isDir: true, absPath: '/ws-b/src/alpha' },
      { name: 'Beta.txt', isDir: false, absPath: '/ws-b/src/Beta.txt' },
      { name: 'zeta.txt', isDir: false, absPath: '/ws-b/src/zeta.txt' },
    ],
    resolvedFrom: '/ws-b',
  });
  assert.deepEqual(harness.service.exists({ absPath: 'relative/file' }), { exists: false });
  assert.deepEqual(harness.service.readDirectory({ absPath: 'relative/dir' }), {
    ok: false,
    status: 'invalid_path',
    entries: [],
    error: 'not_absolute',
  });
});

test('git diff applies working, staged, and last-commit fallbacks in order', async () => {
  const responses = new Map([
    ['rev-parse --show-toplevel', '/repo\n'],
    ['ls-files --error-unmatch -- src/file.txt', 'src/file.txt\n'],
    ['diff -- src/file.txt', ''],
    ['diff --staged -- src/file.txt', ''],
    ['diff HEAD~1 HEAD -- src/file.txt', 'last diff'],
  ]);
  const harness = createHarness({
    nodes: [
      ['/repo', directory()],
      ['/repo/src/file.txt', file('current')],
    ],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (!responses.has(key)) throw new Error(`unexpected git call: ${key}`);
      return { stdout: responses.get(key) };
    },
  });

  assert.deepEqual(await harness.service.getGitDiff({
    absPath: '/repo/src/file.txt',
    workspaceRoot: '/repo',
  }), {
    ok: true,
    status: 'last_commit',
    diffText: 'last diff',
    resolvedFrom: undefined,
  });
  assert.deepEqual(harness.gitCalls.map(([, args]) => args), [
    ['rev-parse', '--show-toplevel'],
    ['ls-files', '--error-unmatch', '--', 'src/file.txt'],
    ['diff', '--', 'src/file.txt'],
    ['diff', '--staged', '--', 'src/file.txt'],
    ['diff', 'HEAD~1', 'HEAD', '--', 'src/file.txt'],
  ]);
});

test('git diff handles recovered untracked files and non-repositories', async () => {
  const recovered = createHarness({
    nodes: [
      ['/ws-b', directory()],
      ['/ws-b/new.txt', file('new')],
    ],
    settings: { workspaces: [{ path: '/ws-b' }], activeWorkspace: null },
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { stdout: '/ws-b\n' };
      if (key.startsWith('ls-files ')) throw new Error('untracked');
      if (key === 'diff --no-index -- /dev/null /ws-b/new.txt') {
        const error = new Error('different');
        error.stdout = 'new file diff';
        throw error;
      }
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await recovered.service.getGitDiff({
    absPath: '/old/new.txt',
    relPath: '/new.txt',
  }), {
    ok: true,
    status: 'untracked',
    diffText: 'new file diff',
    resolvedFrom: '/ws-b',
  });

  const nonRepo = createHarness({
    nodes: [['/plain/file.txt', file('text')]],
    executeGit: async () => {
      throw new Error('not a repository');
    },
  });
  assert.deepEqual(await nonRepo.service.getGitDiff({ absPath: '/plain/file.txt' }), {
    ok: false,
    status: 'not_git_repo',
    diffText: '',
    error: 'not_a_git_repository',
  });
});

test('git range diff and branch list stay inside a known repository', async () => {
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'diff --no-color abc def') return { stdout: 'range diff' };
      if (key === 'branch --show-current') return { stdout: 'develop\n' };
      if (key === 'for-each-ref --format=%(refname:short) refs/heads') return { stdout: 'develop\nmain\n' };
      if (key === 'for-each-ref --format=%(refname:short) refs/remotes') {
        return { stdout: 'origin/HEAD\norigin/main\norigin/0.0.7\n' };
      }
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await harness.service.getGitRangeDiff({
    workspaceRoot: '/repo',
    fromRef: 'abc',
    toRef: 'def',
  }), {
    ok: true,
    status: 'ok',
    diffText: 'range diff',
    fromRef: 'abc',
    toRef: 'def',
  });
  assert.deepEqual(await harness.service.getGitRangeDiff({
    workspaceRoot: '/repo',
    fromRef: '--output=/tmp/x',
  }), {
    ok: false,
    status: 'invalid_ref',
    diffText: '',
    error: 'invalid_ref',
  });
  assert.deepEqual(await harness.service.listGitBranches({ workspaceRoot: '/repo' }), {
    ok: true,
    branches: ['develop', 'main', 'origin/main', 'origin/0.0.7'],
    localBranches: ['develop', 'main'],
    remoteBranches: ['origin/main', 'origin/0.0.7'],
    current: 'develop',
    repoRoot: '/repo',
  });
});

test('createGitBranch writes a local ref without checking it out', async () => {
  const calls = [];
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- feature origin/0.0.7') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'develop\n' };
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: 'feature',
    startPoint: 'origin/0.0.7',
  }), {
    ok: true,
    status: 'created',
    name: 'feature',
    current: 'develop',
    repoRoot: '/repo',
    pushed: false,
    pushError: null,
  });
  assert.deepEqual(calls, [
    'rev-parse --show-toplevel',
    'branch -- feature origin/0.0.7',
    'branch --show-current',
  ]);
  assert.equal(calls.some((key) => key.includes('checkout')), false);
  assert.equal(calls.some((key) => key.includes('push')), false);

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '--output=/tmp/x',
  }), {
    ok: false,
    status: 'invalid_name',
    current: null,
    error: 'invalid_branch_name',
  });
});

test('createGitBranch with push creates the branch then pushes with upstream tracking', async () => {
  const calls = [];
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- 0.0.11 origin/main') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'main\n' };
      if (key === 'remote') return { stdout: 'origin\nupstream\n' };
      if (key === 'push -u -- origin 0.0.11:0.0.11') return { stdout: '' };
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '0.0.11',
    startPoint: 'origin/main',
    push: true,
  }), {
    ok: true,
    status: 'created',
    name: '0.0.11',
    current: 'main',
    repoRoot: '/repo',
    pushed: true,
    pushError: null,
  });
  assert.deepEqual(calls.slice(-2), ['remote', 'push -u -- origin 0.0.11:0.0.11']);
});

test('createGitBranch with push can track a differently named remote branch', async () => {
  const calls = [];
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- release 0.0.10') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'main\n' };
      if (key === 'remote') return { stdout: 'origin\n' };
      if (key === 'push -u -- origin release:0.0.11') return { stdout: '' };
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: 'release',
    startPoint: '0.0.10',
    push: true,
    upstreamRemote: 'origin',
    upstreamBranch: '0.0.11',
  }), {
    ok: true,
    status: 'created',
    name: 'release',
    current: 'main',
    repoRoot: '/repo',
    pushed: true,
    pushError: null,
  });
  assert.deepEqual(calls.slice(-2), ['remote', 'push -u -- origin release:0.0.11']);
});

test('createGitBranch without push does not contact the remote', async () => {
  const calls = [];
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- 0.0.11') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'main\n' };
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '0.0.11',
    push: false,
    upstreamRemote: 'origin',
    upstreamBranch: 'other',
  }), {
    ok: true,
    status: 'created',
    name: '0.0.11',
    current: 'main',
    repoRoot: '/repo',
    pushed: false,
    pushError: null,
  });
  assert.equal(calls.some((call) => call.startsWith('push ') || call === 'remote'), false);
});

test('createGitBranch rejects an unsafe upstream name without writing a ref', async () => {
  const calls = [];
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      calls.push(args.join(' '));
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    },
  });

  assert.deepEqual(await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '0.0.11',
    push: true,
    upstreamRemote: 'origin',
    upstreamBranch: '--output=/tmp/x',
  }), {
    ok: false,
    status: 'invalid_name',
    current: null,
    error: 'invalid_upstream',
  });
  assert.deepEqual(calls, []);
});

test('createGitBranch push failure is non-blocking and reports the reason', async () => {
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- 0.0.11') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'main\n' };
      if (key === 'remote') return { stdout: 'origin\n' };
      if (key === 'push -u -- origin 0.0.11:0.0.11') {
        throw new Error('fatal: Authentication failed');
      }
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  const result = await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '0.0.11',
    push: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'created');
  assert.equal(result.pushed, false);
  assert.match(result.pushError, /Authentication failed/);
});

test('createGitBranch push without any remote reports no_remote', async () => {
  const harness = createHarness({
    nodes: [['/repo', directory()]],
    executeGit: async (_cwd, args) => {
      const key = args.join(' ');
      if (key === 'rev-parse --show-toplevel') return { stdout: '/repo\n' };
      if (key === 'branch -- 0.0.11') return { stdout: '' };
      if (key === 'branch --show-current') return { stdout: 'main\n' };
      if (key === 'remote') return { stdout: '' };
      throw new Error(`unexpected git call: ${key}`);
    },
  });

  const result = await harness.service.createGitBranch({
    workspaceRoot: '/repo',
    name: '0.0.11',
    push: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'created');
  assert.equal(result.pushed, false);
  assert.equal(result.pushError, 'no_remote');
});

test('text reads preserve not-found, file-only, size, binary, and UTF-8 guards', async () => {
  const binary = Buffer.from([65, 0, 66]);
  const harness = createHarness({
    nodes: [
      ['/dir', directory()],
      ['/large.txt', { kind: 'file', buffer: Buffer.from('x'), size: (2 * 1024 * 1024) + 1 }],
      ['/binary.bin', file(binary)],
      ['/text.txt', file('hello')],
    ],
    settings: { workspaces: [], activeWorkspace: null },
  });

  assert.deepEqual(await harness.service.readFile({ absPath: '/missing.txt' }), {
    ok: false,
    status: 'not_found',
    content: '',
    error: 'file_not_found',
  });
  assert.deepEqual(await harness.service.readFile({ absPath: '/dir' }), {
    ok: false,
    status: 'not_file',
    content: '',
    error: 'not_a_file',
    resolvedFrom: undefined,
  });
  assert.deepEqual(await harness.service.readFile({ absPath: '/large.txt' }), {
    ok: false,
    status: 'too_large',
    content: '',
    size: (2 * 1024 * 1024) + 1,
    resolvedFrom: undefined,
    error: 'file_too_large',
  });
  assert.deepEqual(await harness.service.readFile({ absPath: '/binary.bin' }), {
    ok: false,
    status: 'binary',
    content: '',
    size: 3,
    resolvedFrom: undefined,
    error: 'binary_file',
  });
  assert.deepEqual(await harness.service.readFile({ absPath: '/text.txt' }), {
    ok: true,
    status: 'ok',
    content: 'hello',
    size: 5,
    resolvedFrom: undefined,
  });
});

test('watchers are diffed per sender and closed on error, destruction, and service disposal', () => {
  const harness = createHarness({
    nodes: [
      ['/a', directory()],
      ['/b', directory()],
    ],
  });
  const sender = new FakeSender(7);

  assert.deepEqual(harness.service.watchDirectories(sender, { paths: ['/a', '/b'] }), {
    ok: true,
    watching: ['/a', '/b'],
  });
  const [watchA, watchB] = harness.watchers;
  assert.deepEqual(watchA.options, { persistent: false });

  watchB.onChange();
  assert.deepEqual(sender.messages, [['fs:dir-changed', { dirPath: '/b' }]]);

  assert.deepEqual(harness.service.watchDirectories(sender, { paths: ['/b'] }), {
    ok: true,
    watching: ['/b'],
  });
  assert.equal(watchA.closeCount, 1);

  watchB.emit('error', new Error('gone'));
  assert.equal(watchB.closeCount, 1);
  assert.deepEqual(harness.service.watchDirectories(sender, { paths: [] }), {
    ok: true,
    watching: [],
  });

  harness.service.watchDirectories(sender, { paths: ['/a'] });
  const watchAAgain = harness.watchers.at(-1);
  sender.destroy();
  assert.equal(watchAAgain.closeCount, 1);

  const secondSender = new FakeSender(8);
  harness.service.watchDirectories(secondSender, { paths: ['/b'] });
  const watchBAgain = harness.watchers.at(-1);
  harness.service.dispose();
  harness.service.dispose();
  assert.equal(watchBAgain.closeCount, 1);
});

test('writeFile creates empty files and refuses existing paths', () => {
  const harness = createHarness({
    nodes: [
      ['/ws-a', directory()],
      ['/ws-a/existing.txt', file('keep')],
    ],
  });

  assert.deepEqual(harness.service.writeFile({ absPath: '/ws-a/new.txt', content: 'hello' }), {
    ok: true,
    status: 'ok',
    path: '/ws-a/new.txt',
  });
  assert.deepEqual(harness.written, [['/ws-a/new.txt', 'hello']]);
  assert.equal(harness.nodes.get('/ws-a/new.txt')?.kind, 'file');

  assert.deepEqual(harness.service.writeFile({ absPath: '/ws-a/existing.txt' }), {
    ok: false,
    status: 'already_exists',
    error: 'path_already_exists',
    path: '/ws-a/existing.txt',
    resolvedFrom: undefined,
  });
  assert.deepEqual(harness.service.writeFile({ absPath: 'relative.txt' }), {
    ok: false,
    status: 'invalid_path',
    error: 'invalid_path',
  });
});

test('mkdir creates directories and refuses existing paths', () => {
  const harness = createHarness({
    nodes: [
      ['/ws-a', directory()],
      ['/ws-a/docs', directory()],
    ],
  });

  assert.deepEqual(harness.service.mkdir({ absPath: '/ws-a/new-folder' }), {
    ok: true,
    status: 'ok',
    path: '/ws-a/new-folder',
  });
  assert.deepEqual(harness.created, ['/ws-a/new-folder']);
  assert.equal(harness.nodes.get('/ws-a/new-folder')?.kind, 'directory');

  assert.deepEqual(harness.service.mkdir({ absPath: '/ws-a/docs' }), {
    ok: false,
    status: 'already_exists',
    error: 'path_already_exists',
    path: '/ws-a/docs',
    resolvedFrom: undefined,
  });
});

test('readImageDataUrl returns base64 dataUrl for image files', () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const harness = createHarness({
    nodes: [
      ['/ws-a', directory()],
      ['/ws-a/shot.png', file(pngMagic)],
      ['/ws-a/notes.txt', file(Buffer.from('hello'))],
    ],
  });

  const ok = harness.service.readImageDataUrl({ absPath: '/ws-a/shot.png' });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'ok');
  assert.equal(ok.mimeType, 'image/png');
  assert.ok(ok.dataUrl.startsWith('data:image/png;base64,'));
  assert.equal(ok.size, pngMagic.length);

  assert.deepEqual(harness.service.readImageDataUrl({ absPath: '/ws-a/notes.txt' }), {
    ok: false,
    status: 'unsupported_type',
    dataUrl: '',
    error: 'not_an_image',
    resolvedFrom: undefined,
  });

  assert.deepEqual(harness.service.readImageDataUrl({ absPath: '/ws-a/missing.png' }), {
    ok: false,
    status: 'not_found',
    dataUrl: '',
    error: 'file_not_found',
  });
});

