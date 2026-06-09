import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSettingsStore } from './settings-store.mjs';

let tmpRoot;
let settingsFile;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'peer-settings-'));
  settingsFile = path.join(tmpRoot, 'settings.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('getAll returns {} when file is absent', () => {
  const store = createSettingsStore({ settingsFile });
  assert.deepEqual(store.getAll(), {});
});

test('merge writes file and is shallow (only overrides given keys)', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appearance: { mode: 'dark', density: 'comfortable' } });
  store.merge({ appMode: 'work' });

  const all = store.getAll();
  assert.deepEqual(all.appearance, { mode: 'dark', density: 'comfortable' });
  assert.equal(all.appMode, 'work');
  assert.ok(existsSync(settingsFile));
});

test('merge overrides only the top-level key, leaves siblings intact', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appearance: { mode: 'light' }, appMode: 'thinking' });
  store.merge({ appearance: { mode: 'dark' } });

  const all = store.getAll();
  assert.deepEqual(all.appearance, { mode: 'dark' });
  assert.equal(all.appMode, 'thinking', 'sibling key preserved');
});

test('merge ignores non-object payloads', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appMode: 'work' });
  assert.deepEqual(store.merge(null), { appMode: 'work' });
  assert.deepEqual(store.merge('garbage'), { appMode: 'work' });
});

test('getAll tolerates corrupted file', () => {
  const store = createSettingsStore({ settingsFile });
  store.merge({ appMode: 'work' });
  // 手动写坏
  writeFileSync(settingsFile, '{ not json', 'utf8');
  assert.deepEqual(store.getAll(), {});
});
