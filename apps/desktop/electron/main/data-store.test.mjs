import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ZEUS_ENTRIES,
  getDataHome,
  pathOf,
  listEntries,
  migrateFromLegacy,
  exportBundle,
  importBundle,
} from './data-store.mjs';

let tmpRoot;
let dataHome;
let legacy;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'data-store-'));
  dataHome = path.join(tmpRoot, '.peer-agent');
  legacy = path.join(tmpRoot, 'legacy-userData');
  // getDataHome() 每次读 env（不缓存路径），所以 test 间切换隔离根有效
  process.env.PEER_AGENT_HOME = dataHome;
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('getDataHome honours PEER_AGENT_HOME override and creates it', () => {
  assert.equal(getDataHome(), dataHome);
  assert.ok(existsSync(dataHome));
});

test('pathOf resolves declared entries under the home', () => {
  assert.equal(pathOf('skills'), path.join(dataHome, 'skills'));
  assert.equal(pathOf('developerSettings'), path.join(dataHome, 'developer-settings.json'));
  assert.equal(pathOf('auth'), path.join(dataHome, 'auth'));
});

test('pathOf throws on unknown entry', () => {
  assert.throws(() => pathOf('does-not-exist'), /unknown entry/);
});

test('listEntries filters by scope', () => {
  const portable = listEntries({ scope: 'portable' }).map((e) => e.key).sort();
  const expectedPortable = Object.entries(ZEUS_ENTRIES)
    .filter(([, entry]) => entry.scope === 'portable')
    .map(([key]) => key)
    .sort();
  assert.deepEqual(portable, expectedPortable);
  // device / cache 不在 portable 里
  assert.ok(!portable.includes('auth'));
  assert.ok(!portable.includes('shellArtifacts'));
  // 不带 filter 返回全部
  assert.equal(listEntries().length, Object.keys(ZEUS_ENTRIES).length);
});

test('migrateFromLegacy copies declared entries, skips existing, keeps legacy intact', () => {
  // 造旧 userData 数据
  mkdirSync(path.join(legacy, 'auth'), { recursive: true });
  writeFileSync(path.join(legacy, 'auth', 'buc-token.bin'), 'tok');
  mkdirSync(path.join(legacy, 'skills', 'skill-x'), { recursive: true });
  writeFileSync(path.join(legacy, 'skills', 'skill-x', 'SKILL.md'), 'body');
  writeFileSync(path.join(legacy, 'developer-settings.json'), '{"legacy":true}');
  // 目标已存在的项应被跳过（不覆盖）
  mkdirSync(dataHome, { recursive: true });
  writeFileSync(path.join(dataHome, 'developer-settings.json'), '{"existing":true}');

  const { migrated } = migrateFromLegacy(legacy);

  assert.ok(migrated.includes('auth'));
  assert.ok(migrated.includes('skills'));
  assert.ok(!migrated.includes('developerSettings'), 'existing target must be skipped');

  // 迁移结果正确
  assert.equal(readFileSync(path.join(dataHome, 'auth', 'buc-token.bin'), 'utf8'), 'tok');
  assert.equal(readFileSync(path.join(dataHome, 'skills', 'skill-x', 'SKILL.md'), 'utf8'), 'body');
  // 已存在的没被覆盖
  assert.equal(
    readFileSync(path.join(dataHome, 'developer-settings.json'), 'utf8'),
    '{"existing":true}',
  );
  // 旧数据保留做回退
  assert.ok(existsSync(path.join(legacy, 'auth', 'buc-token.bin')));
});

test('migrateFromLegacy is idempotent (second run copies nothing new)', () => {
  mkdirSync(path.join(legacy, 'skills'), { recursive: true });
  writeFileSync(path.join(legacy, 'skills', 'a.md'), 'x');

  assert.ok(migrateFromLegacy(legacy).migrated.includes('skills'));
  assert.deepEqual(migrateFromLegacy(legacy).migrated, [], 'second run is a no-op');
});

test('migrateFromLegacy no-ops on empty or self path', () => {
  assert.deepEqual(migrateFromLegacy(null).migrated, []);
  assert.deepEqual(migrateFromLegacy(dataHome).migrated, []);
});

test('exportBundle copies only portable entries (excludes device/cache)', () => {
  mkdirSync(path.join(dataHome, 'skills'), { recursive: true });
  writeFileSync(path.join(dataHome, 'skills', 's.md'), 'x');
  writeFileSync(path.join(dataHome, 'settings.json'), '{"a":1}');
  mkdirSync(path.join(dataHome, 'auth'), { recursive: true }); // device → 不导出
  writeFileSync(path.join(dataHome, 'auth', 'tok'), 't');

  const target = path.join(tmpRoot, 'export');
  const { exported } = exportBundle(target);

  assert.ok(exported.includes('skills'));
  assert.ok(exported.includes('settings'));
  assert.ok(!exported.includes('auth'), 'device-scope entries must not be exported');
  assert.ok(existsSync(path.join(target, 'skills', 's.md')));
  assert.ok(existsSync(path.join(target, 'settings.json')));
  assert.ok(!existsSync(path.join(target, 'auth')));
});

test('importBundle restores portable entries into home (overwrites)', () => {
  const src = path.join(tmpRoot, 'bundle');
  mkdirSync(path.join(src, 'skills'), { recursive: true });
  writeFileSync(path.join(src, 'skills', 'imported.md'), 'y');
  writeFileSync(path.join(src, 'settings.json'), '{"imported":true}');
  // home 已有旧 settings → 导入应覆盖
  mkdirSync(dataHome, { recursive: true });
  writeFileSync(path.join(dataHome, 'settings.json'), '{"old":true}');

  const { imported } = importBundle(src);

  assert.ok(imported.includes('skills'));
  assert.ok(imported.includes('settings'));
  assert.equal(readFileSync(path.join(dataHome, 'settings.json'), 'utf8'), '{"imported":true}');
  assert.ok(existsSync(path.join(dataHome, 'skills', 'imported.md')));
});
