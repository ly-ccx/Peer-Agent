import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppshotService, APPSHOT_ARTIFACT_SCHEME } from './appshot-service.mjs';

function fixture(overrides = {}) {
  const logs = [];
  const artifactsDir = mkdtempSync(path.join(tmpdir(), 'appshot-test-'));
  const service = createAppshotService({
    getScreenPermissionStatus: () => 'granted',
    artifactsDir,
    log: (line) => logs.push(line),
    resolveFrontmost: async () => ({ appName: 'TextEdit', pid: 4242, bundleId: 'com.apple.TextEdit' }),
    listWindows: async () => [
      { windowId: 77, pid: 4242, owner: 'TextEdit', title: 'notes.txt', x: 0, y: 0, width: 800, height: 600 },
    ],
    captureWindow: async ({ outFile }) => { writeFileSync(outFile, Buffer.from('fake-png-bytes')); },
    isSelfPid: (pid) => pid === 999,
    ...overrides,
  });
  return { service, logs, artifactsDir };
}

test('success path returns artifact-backed payload', async () => {
  const { service, logs } = fixture();
  const result = await service.capture();
  assert.equal(result.ok, true);
  assert.equal(result.payload.source.appName, 'TextEdit');
  assert.equal(result.payload.source.windowId, 77);
  assert.ok(result.payload.visual.artifactRef.startsWith(APPSHOT_ARTIFACT_SCHEME));
  assert.ok(result.payload.visual.byteSize > 0);
  assert.equal(result.payload.text.mode, 'none');
  assert.ok(Number.isFinite(result.payload.captureDurationMs));
  // ADR 59 decision 4: logs must not leak the window title.
  assert.ok(logs.every((line) => !line.includes('notes.txt')));
});

test('permission_denied comes from preflight only', async () => {
  let captureCalled = false;
  const { service } = fixture({
    getScreenPermissionStatus: () => 'denied',
    captureWindow: async () => { captureCalled = true; },
  });
  const result = await service.capture();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission_denied');
  assert.equal(captureCalled, false, 'must not attempt capture without permission');
});

test('peer_frontmost when frontmost pid is our own', async () => {
  const { service } = fixture({
    resolveFrontmost: async () => ({ appName: 'Peer Agent', pid: 999, bundleId: 'com.peer.agent' }),
  });
  const result = await service.capture();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'peer_frontmost');
});

test('no_window when frontmost app has no on-screen window', async () => {
  const { service } = fixture({ listWindows: async () => [{ windowId: 1, pid: 1, owner: 'other' }] });
  const result = await service.capture();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_window');
});

test('window_not_capturable when capture CLI fails despite granted permission', async () => {
  const { service } = fixture({
    captureWindow: async () => { throw new Error('could not create image from window'); },
  });
  const result = await service.capture();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'window_not_capturable');
});

test('window_not_capturable when capture produces an empty file', async () => {
  const { service } = fixture({
    captureWindow: async ({ outFile }) => { writeFileSync(outFile, Buffer.alloc(0)); },
  });
  const result = await service.capture();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'window_not_capturable');
});
