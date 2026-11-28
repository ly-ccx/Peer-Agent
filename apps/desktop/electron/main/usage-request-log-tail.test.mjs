import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageRequestLog } from './usage-request-log.mjs';

test('usage tail retains chronological last records across a UTF-8 block boundary', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-usage-tail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'usage.jsonl');
  writeFileSync(file, Array.from({ length: 4000 }, (_, id) => JSON.stringify({ id, label: '原始用量'.repeat(12) })).join('\n') + '\n');
  const rows = createUsageRequestLog({ logFile: file }).readAll({ limit: 3 });
  assert.deepEqual(rows.map(row => row.id), [3997, 3998, 3999]);
  assert.equal(rows[0].label, '原始用量'.repeat(12));
});

test('a corrupt or oversized old record does not make the latest usage unreadable', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-usage-tail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'usage.jsonl');
  writeFileSync(file, 'x'.repeat(9 * 1024 * 1024) + '\n{bad}\n{"id":"last"}\n');
  assert.deepEqual(createUsageRequestLog({ logFile: file }).readAll({ limit: 3 }), [{ id: 'last' }]);
});

test('readForBudget caches unchanged file stats and invalidates on append', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-usage-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'usage.jsonl');
  const log = createUsageRequestLog({ logFile: file });
  const now = Date.now();
  log.append({ id: 'r1', at: new Date(now).toISOString(), requestPurpose: 'input_prediction', usage: { inputTokens: 100, outputTokens: 20 } });
  const first = log.readForBudget(now - 60_000);
  const second = log.readForBudget(now - 60_000);
  assert.equal(first, second, 'identical file stat + sinceMs should hit cache without re-parsing');
  assert.equal(first.rows.length, 1);
  log.append({ id: 'r2', at: new Date(now + 1000).toISOString(), requestPurpose: 'input_prediction', usage: { inputTokens: 200, outputTokens: 30 } });
  const third = log.readForBudget(now - 60_000);
  assert.notEqual(third, first);
  assert.equal(third.rows.length, 2);
});
