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

