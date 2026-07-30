import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppshotPermissionPreflight,
  openScreenRecordingSettings,
  APPSHOT_PERMISSION_HINT_KEYS,
} from './appshot-permission-preflight.mjs';

test('granted state allows capture with granted hint', () => {
  const result = buildAppshotPermissionPreflight({
    getMediaAccessStatus: (type) => (type === 'screen' ? 'granted' : 'not-determined'),
    platform: 'darwin',
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'granted');
  assert.equal(result.canCapture, true);
  assert.equal(result.hintKey, APPSHOT_PERMISSION_HINT_KEYS.granted);
});

test('denied state blocks capture with denied hint', () => {
  const result = buildAppshotPermissionPreflight({
    getMediaAccessStatus: () => 'denied',
    platform: 'darwin',
  });
  assert.equal(result.canCapture, false);
  assert.equal(result.status, 'denied');
  assert.equal(result.hintKey, APPSHOT_PERMISSION_HINT_KEYS.denied);
});

test('not-determined also blocks capture (no silent fake success)', () => {
  const result = buildAppshotPermissionPreflight({
    getMediaAccessStatus: () => 'not-determined',
    platform: 'darwin',
  });
  assert.equal(result.canCapture, false);
});

test('non-darwin platform reports unsupported, not denied', () => {
  const result = buildAppshotPermissionPreflight({
    getMediaAccessStatus: () => 'granted',
    platform: 'win32',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported-platform');
  assert.equal(result.canCapture, false);
});

test('openScreenRecordingSettings uses ScreenCapture deep link first', async () => {
  const opened = [];
  const result = await openScreenRecordingSettings({
    shellOpenExternal: async (url) => { opened.push(url); },
  });
  assert.equal(result.ok, true);
  assert.ok(result.url.includes('Privacy_ScreenCapture'));
  assert.equal(opened.length, 1);
});

test('openScreenRecordingSettings falls back to generic privacy pane', async () => {
  const opened = [];
  const result = await openScreenRecordingSettings({
    shellOpenExternal: async (url) => {
      opened.push(url);
      if (url.includes('Privacy_ScreenCapture')) throw new Error('nope');
    },
  });
  assert.equal(result.ok, true);
  assert.equal(opened.length, 3);
  assert.ok(result.url.endsWith('Privacy'));
});

test('openScreenRecordingSettings without opener is a structured failure', async () => {
  const result = await openScreenRecordingSettings({});
  assert.equal(result.ok, false);
  assert.equal(result.error, 'shell_open_unavailable');
});
