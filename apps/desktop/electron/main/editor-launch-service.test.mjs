import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createEditorLaunchService } from './editor-launch-service.mjs';

function macService({ installed = [], spawnResult = { ok: true }, bundleIds = {} } = {}) {
  const calls = [];
  const service = createEditorLaunchService({
    platform: 'darwin',
    env: { HOME: '/Users/tester' },
    exists: (candidate) => installed.includes(candidate),
    readBundleId: (appPath) => bundleIds[appPath] ?? null,
    async spawnDetached(command, args) {
      calls.push([command, ...args]);
      return spawnResult;
    },
  });
  return { service, calls };
}

test('detectWithIcons prefers the CFBundleIconFile icns over the .app bundle path', async () => {
  const icns = '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns';
  const files = new Set([
    '/Applications/Visual Studio Code.app',
    '/Applications/Visual Studio Code.app/Contents/Info.plist',
    icns,
  ]);
  const seen = [];
  const service = createEditorLaunchService({
    platform: 'darwin',
    env: { HOME: '/Users/tester' },
    exists: (candidate) => files.has(candidate),
    readBundleId: () => 'com.microsoft.VSCode',
    readAppIcon: async (iconPath) => {
      seen.push(iconPath);
      return `data:image/png;base64,${iconPath.split('/').pop()}`;
    },
    resolveMacAppIconPath: (appPath) =>
      appPath === '/Applications/Visual Studio Code.app' ? icns : null,
    spawnDetached: async () => ({ ok: true }),
  });

  const editors = await service.detectWithIcons();
  assert.deepEqual(seen, [icns]);
  assert.equal(editors[0].iconDataUrl, 'data:image/png;base64,Code.icns');
});

test('detectWithIcons attaches the host-provided real app icon', async () => {
  const { service } = macService({
    installed: ['/Applications/Visual Studio Code.app'],
    bundleIds: { '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' },
  });
  const withIcons = createEditorLaunchService({
    platform: 'darwin',
    env: { HOME: '/Users/tester' },
    exists: (candidate) => candidate === '/Applications/Visual Studio Code.app',
    readBundleId: () => 'com.microsoft.VSCode',
    readAppIcon: async (appPath) => `data:image/png;base64,${appPath.split('/').pop()}`,
    resolveMacAppIconPath: () => null,
    spawnDetached: async () => ({ ok: true }),
  });

  const editors = await withIcons.detectWithIcons();
  assert.equal(editors.length, 1);
  assert.equal(editors[0].id, 'vscode');
  assert.equal(editors[0].iconDataUrl, 'data:image/png;base64,Visual Studio Code.app');
  assert.equal(service.detect()[0].iconDataUrl, undefined);
});

test('detect only reports known editors that exist on this machine', () => {
  const { service } = macService({
    installed: ['/Applications/Visual Studio Code.app', '/Users/tester/Applications/Zed.app'],
    bundleIds: { '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' },
  });

  assert.deepEqual(
    service.detect().map((editor) => ({ id: editor.id, bundleId: editor.bundleId })),
    [
      { id: 'vscode', bundleId: 'com.microsoft.VSCode' },
      { id: 'zed', bundleId: null },
    ],
  );
  assert.equal(service.isAvailable('vscode'), true);
  assert.equal(service.isAvailable('cursor'), false);
});

test('launch prefers bundle id and falls back to the app path', async () => {
  const { service, calls } = macService({
    installed: ['/Applications/Visual Studio Code.app', '/Applications/Zed.app'],
    bundleIds: { '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' },
  });

  assert.deepEqual(await service.launch({ editorId: 'vscode', absPath: '/tmp/a.txt' }), {
    ok: true,
    editorId: 'vscode',
  });
  assert.deepEqual(await service.launch({ editorId: 'zed', absPath: '/tmp/project' }), {
    ok: true,
    editorId: 'zed',
  });

  assert.deepEqual(calls, [
    ['/usr/bin/open', '-b', 'com.microsoft.VSCode', '/tmp/a.txt'],
    ['/usr/bin/open', '-a', '/Applications/Zed.app', '/tmp/project'],
  ]);
});

test('launch treats a directory target exactly like a file target', async () => {
  const { service, calls } = macService({
    installed: ['/Applications/Visual Studio Code.app'],
    bundleIds: { '/Applications/Visual Studio Code.app': 'com.microsoft.VSCode' },
  });

  const result = await service.launch({ editorId: 'vscode', absPath: '/tmp/some/folder' });

  assert.deepEqual(result, { ok: true, editorId: 'vscode' });
  assert.deepEqual(calls, [
    ['/usr/bin/open', '-b', 'com.microsoft.VSCode', '/tmp/some/folder'],
  ]);
});

test('launch rejects bad input, unknown editors, and reports launch failure', async () => {
  const { service } = macService({ installed: ['/Applications/Zed.app'] });

  assert.deepEqual(await service.launch(), { ok: false, reason: 'invalid_path' });
  assert.deepEqual(await service.launch({ editorId: 'zed', absPath: 'rel.txt' }), {
    ok: false,
    reason: 'not_absolute',
  });
  assert.deepEqual(await service.launch({ absPath: '/tmp/a.txt' }), {
    ok: false,
    reason: 'invalid_editor',
  });
  assert.deepEqual(await service.launch({ editorId: 'nope', absPath: '/tmp/a.txt' }), {
    ok: false,
    reason: 'editor_not_found',
  });

  const failing = macService({
    installed: ['/Applications/Zed.app'],
    spawnResult: { ok: false, message: 'open failed' },
  });
  assert.deepEqual(await failing.service.launch({ editorId: 'zed', absPath: '/tmp/a.txt' }), {
    ok: false,
    reason: 'launch_failed',
    message: 'open failed',
  });
});

test('windows detection uses executables and launches them directly', async () => {
  const exe = path.win32.join('C:\\Program Files', 'Microsoft VS Code\\Code.exe');
  const calls = [];
  const service = createEditorLaunchService({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: (candidate) => candidate === exe,
    async spawnDetached(command, args) {
      calls.push([command, ...args]);
      return { ok: true };
    },
  });

  assert.deepEqual(
    service.detect().map((editor) => ({ id: editor.id, exePath: editor.exePath })),
    [{ id: 'vscode', exePath: exe }],
  );
  assert.deepEqual(await service.launch({ editorId: 'vscode', absPath: 'C:\\work\\a.txt' }), {
    ok: true,
    editorId: 'vscode',
  });
  assert.deepEqual(calls, [[exe, 'C:\\work\\a.txt']]);
});

test('unsupported platforms report no editors', () => {
  const service = createEditorLaunchService({
    platform: 'linux',
    exists: () => true,
    spawnDetached: async () => ({ ok: true }),
  });

  assert.deepEqual(service.detect(), []);
});
