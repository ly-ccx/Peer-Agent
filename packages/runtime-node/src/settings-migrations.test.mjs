import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadMigratedSettings, runSettingsMigrations } from './settings-migrations.mjs';

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'peer-settings-migration-'));
}

test('an existing settings file without a version becomes schemaVersion 1', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{ "appMode": "work" }\n');
  const now = () => new Date('2026-09-26T01:02:03.000Z');
  const loaded = loadMigratedSettings(file, { now });
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.appMode, 'work');
  const again = loadMigratedSettings(file, { now: () => new Date('2026-09-26T04:05:06.000Z') });
  assert.deepEqual(again, loaded);
  const raw = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(raw).schemaVersion, 1);
  const backups = readdirSync(dir).filter((name) => name.startsWith('settings.json.bak-'));
  assert.deepEqual(backups, ['settings.json.bak-v0-2026-09-26T01-02-03.000Z']);
  rmSync(dir, { recursive: true, force: true });
});

test('a second load does not write another backup', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{}\n');
  loadMigratedSettings(file, { now: () => new Date('2026-09-26T01:02:03.000Z') });
  const before = statSync(file).mtimeMs;
  loadMigratedSettings(file, { now: () => new Date('2026-09-26T04:05:06.000Z') });
  assert.equal(statSync(file).mtimeMs, before);
  assert.equal(readdirSync(dir).filter((name) => name.includes('.bak-')).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('only the five newest backups are kept', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  writeFileSync(file, '{}\n');
  for (let index = 0; index < 6; index += 1) {
    writeFileSync(file, `{ "schemaVersion": 0, "n": ${index} }\n`);
    loadMigratedSettings(file, { now: () => new Date(Date.UTC(2026, 0, index + 1)) });
  }
  const backups = readdirSync(dir).filter((name) => name.includes('.bak-')).sort();
  assert.equal(backups.length, 5);
  assert.equal(backups.some((name) => name.includes('2026-01-01')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a newer schema than this build is left untouched', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const body = '{ "schemaVersion": 99, "appMode": "work" }\n';
  writeFileSync(file, body);
  const loaded = loadMigratedSettings(file);
  assert.equal(loaded.schemaVersion, 99);
  assert.equal(readFileSync(file, 'utf8'), body);
  assert.equal(readdirSync(dir).some((name) => name.includes('.bak-')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('a throwing migration leaves the original file in place', () => {
  const dir = tempDir();
  const file = path.join(dir, 'settings.json');
  const body = '{ "appMode": "work" }\n';
  writeFileSync(file, body);
  const notes = [];
  const loaded = loadMigratedSettings(file, {
    log: (message) => notes.push(message),
    migrations: [{
      version: 1,
      up() { throw new Error('boom'); },
    }],
  });
  assert.deepEqual(loaded, { appMode: 'work' });
  assert.equal(readFileSync(file, 'utf8'), body);
  assert.equal(notes.some((message) => message.includes('boom')), true);
  rmSync(dir, { recursive: true, force: true });
});

test('runSettingsMigrations does not invent a version for an already current document', () => {
  const result = runSettingsMigrations({ settings: { schemaVersion: 1, appMode: 'work' } });
  assert.deepEqual(result.applied, []);
  assert.equal(result.settings.appMode, 'work');
});
