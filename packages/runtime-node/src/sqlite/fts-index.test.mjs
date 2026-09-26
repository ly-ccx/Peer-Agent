import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFtsIndex } from './fts-index.mjs';
import { openSqlite } from './open-sqlite.mjs';

function openFixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'peer-fts-'));
  const file = path.join(dir, 'nested', 'memory.sqlite');
  const db = openSqlite(file);
  return { dir, file, db, index: createFtsIndex({ db, name: 'memory' }) };
}

test('trigram search finds Chinese, English, and mixed terms', () => {
  const fixture = openFixture();
  try {
    fixture.index.upsert('zh', '模型分工设置页可以配置档位', { kind: 'fact' });
    fixture.index.upsert('en', 'model routing settings for each role', { kind: 'note' });
    fixture.index.upsert('mix', '这里记录 routing 的默认档位', { kind: 'mix' });
    assert.deepEqual(fixture.index.search('模型分工').map((row) => row.id), ['zh']);
    assert.equal(fixture.index.search('模型分工')[0].meta.kind, 'fact');
    assert.deepEqual(fixture.index.search('routing').map((row) => row.id).sort(), ['en', 'mix']);
    assert.deepEqual(fixture.index.search('routing 档位').map((row) => row.id), ['mix']);
    assert.deepEqual(fixture.index.search('分工').map((row) => row.id), ['zh']);
    assert.equal(fixture.index.count(), 3);
  } finally {
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('short queries, special characters, rebuild, and removal stay safe', () => {
  const fixture = openFixture();
  try {
    fixture.index.upsert('a', 'a_b keeps the underscore', { n: 1 });
    fixture.index.upsert('b', 'plain text', { n: 2 });
    assert.deepEqual(fixture.index.search('_').map((row) => row.id), ['a']);
    assert.deepEqual(fixture.index.search('%'), []);
    assert.doesNotThrow(() => fixture.index.search('a"b *** (模型)'));
    fixture.index.remove('b');
    assert.equal(fixture.index.count(), 1);
    fixture.index.rebuild([{ id: 'c', body: '模型分工重建后仍可检索', meta: { n: 3 } }]);
    assert.deepEqual(fixture.index.search('模型分工').map((row) => row.id), ['c']);
    assert.equal(fixture.index.count(), 1);
    assert.equal(fixture.index.search('模型分工', { limit: 0 }).length, 0);
  } finally {
    fixture.db.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a corrupt database file is quarantined and replaced', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'peer-fts-corrupt-'));
  const file = path.join(dir, 'memory.sqlite');
  writeFileSync(file, 'this is not a sqlite database');
  const db = openSqlite(file);
  try {
    const index = createFtsIndex({ db, name: 'memory' });
    index.upsert('fresh', '新建索引', {});
    assert.equal(index.count(), 1);
    assert.equal(readdirSync(dir).some((name) => name.startsWith('memory.sqlite.corrupt-')), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
