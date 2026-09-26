import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createFtsIndex } from '../../../packages/runtime-node/src/sqlite/fts-index.mjs';
import { openSqlite } from '../../../packages/runtime-node/src/sqlite/open-sqlite.mjs';

const sqliteAvailable = (() => {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

describe('sqlite fts on bun', () => {
  test.skipIf(!sqliteAvailable)('indexes a Chinese phrase', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'peer-tui-fts-'));
    const db = openSqlite(path.join(dir, 'memory.sqlite'));
    try {
      const index = createFtsIndex({ db, name: 'memory' });
      index.upsert('1', '模型分工设置', { ok: true });
      expect(index.search('模型分工').map((row) => row.id)).toEqual(['1']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
