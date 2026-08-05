import assert from 'node:assert/strict';
import test from 'node:test';
import { createFileAccessIpcRegistrations } from './register-file-access-ipc.mjs';

function createHarness() {
  const calls = [];
  const port = (name) => (...args) => {
    calls.push([name, ...args]);
    return name;
  };
  const [registration] = createFileAccessIpcRegistrations({
    fileAccess: {
      getGitDiff: port('git-diff'),
      exists: port('exists'),
      readDirectory: port('read-directory'),
      watchDirectories: port('watch-directories'),
      readFile: port('read-file'),
      writeFile: port('write-file'),
      mkdir: port('mkdir'),
      dispose: port('dispose'),
    },
  });
  const handlers = new Map();
  const dispose = registration.register({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });
  return { registration, handlers, calls, dispose };
}

test('file-access-ipc owns the exact governed file channel set', () => {
  const { registration, handlers } = createHarness();
  assert.equal(registration.owner, 'file-access-ipc');
  assert.deepEqual([...handlers.keys()], [
    'git:diff',
    'fs:exists',
    'fs:read-dir',
    'fs:watch-dirs',
    'file:read',
    'file:write',
    'fs:mkdir',
  ]);
});

test('file-access-ipc projects payloads and returns the watcher disposer', async () => {
  const { handlers, calls, dispose } = createHarness();
  const sender = { id: 9 };
  const payloads = {
    git: { absPath: '/repo/file' },
    exists: { absPath: '/repo/file' },
    readDirectory: { absPath: '/repo' },
    watch: { paths: ['/repo'] },
    readFile: { absPath: '/repo/file' },
    writeFile: { absPath: '/repo/new.txt', content: '' },
    mkdir: { absPath: '/repo/new-dir' },
  };

  await handlers.get('git:diff')({ sender }, payloads.git);
  handlers.get('fs:exists')({ sender }, payloads.exists);
  handlers.get('fs:read-dir')({ sender }, payloads.readDirectory);
  handlers.get('fs:watch-dirs')({ sender }, payloads.watch);
  await handlers.get('file:read')({ sender }, payloads.readFile);
  handlers.get('file:write')({ sender }, payloads.writeFile);
  handlers.get('fs:mkdir')({ sender }, payloads.mkdir);
  dispose();

  assert.deepEqual(calls, [
    ['git-diff', payloads.git],
    ['exists', payloads.exists],
    ['read-directory', payloads.readDirectory],
    ['watch-directories', sender, payloads.watch],
    ['read-file', payloads.readFile],
    ['write-file', payloads.writeFile],
    ['mkdir', payloads.mkdir],
    ['dispose'],
  ]);
});
