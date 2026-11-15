import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConversationStore } from './index.mjs';
import { appendAuxiliaryUsageRecord, scanUsageLedger } from './usage-ledger.mjs';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'peer-ledger-recovery-'));
  const storeDir = path.join(root, 'conversations'), ledger = path.join(root, 'usage', 'requests.jsonl');
  mkdirSync(path.dirname(ledger)); writeFileSync(ledger, '');
  const store = createConversationStore({ storeDir });
  const meta = store.createConversation({ title: 'Synthetic ledger recovery' });
  const input = { usage: { usageScope: 'runtime_turn', providerRequestCount: 2, inputTokens: 10, outputTokens: 3 },
    attribution: { id: 'stable-turn', modelProviderId: 'channel::model', at: '2026-11-15T00:00:00.000Z', role: 'work_session', workspaceId: 'workspace' } };
  return { root, storeDir, ledger, store, meta, input, intent: path.join(storeDir, '.usage-ledger-transaction') };
}
function pending(f) {
  chmodSync(f.ledger, 0o400);
  try { assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, f.input), { code: 'USAGE_LEDGER_COMMIT_UNCERTAIN' }); }
  finally { chmodSync(f.ledger, 0o600); }
  assert.equal(f.store.getConversation(f.meta.id).lifetimeUsage.inputTokens, 10);
  return JSON.parse(readFileSync(f.intent, 'utf8'));
}
function recovered(f) {
  const result = f.store.recordRuntimeTurnUsage(f.meta.id, f.input);
  assert.equal(result.lifetimeUsage.inputTokens, 10); assert.equal(result.lifetimeUsage.runtimeTurnCount, 1);
  assert.equal(existsSync(f.intent), false);
  const next = structuredClone(f.input); next.attribution.id = 'subsequent-turn';
  assert.equal(f.store.recordRuntimeTurnUsage(f.meta.id, next).lifetimeUsage.inputTokens, 20);
  return result;
}
test('actual append EACCES after index publication is recovered once, then admits a new turn', () => { const f = fixture(); pending(f); recovered(f); });
test('exact persisted partial row is completed without truncating or charging twice', () => {
  const f = fixture(), intent = pending(f), line = JSON.stringify(intent.ledgerRow) + '\n';
  writeFileSync(f.ledger, line.slice(0, Math.floor(line.length / 2))); recovered(f);
  assert.equal(readFileSync(f.ledger, 'utf8').split('\n').filter(Boolean).length, 2);
});
test('an already appended row with a retained intent is only acknowledged', () => {
  const f = fixture(), intent = pending(f); writeFileSync(f.ledger, JSON.stringify(intent.ledgerRow) + '\n'); recovered(f);
});
test('auxiliary complete rows after a pending intent are retained and serialized', () => {
  const f = fixture(); pending(f); const row = { id: 'aux', requestPurpose: 'input_prediction', usageScope: 'provider_request' };
  appendAuxiliaryUsageRecord(f.ledger, row); recovered(f);
  assert.deepEqual(JSON.parse(readFileSync(f.ledger, 'utf8').split('\n')[0]), row);
});
test('unknown partial bytes are preserved and block both billing and auxiliary appends', () => {
  const f = fixture(); pending(f); writeFileSync(f.ledger, 'unrecognized partial bytes');
  const before = readFileSync(f.intent);
  assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, f.input), { code: 'USAGE_LEDGER_CONFLICT' });
  assert.throws(() => appendAuxiliaryUsageRecord(f.ledger, { id: 'aux' }), { code: 'USAGE_LEDGER_INVALID' });
  assert.equal(readFileSync(f.ledger, 'utf8'), 'unrecognized partial bytes'); assert.deepEqual(readFileSync(f.intent), before);
});
test('counter conflict and unknown intent schema fail closed without rewriting their files', () => {
  const f = fixture(), intent = pending(f), index = path.join(f.storeDir, 'index.jsonl');
  const rows = readFileSync(index, 'utf8').trim().split('\n').map(JSON.parse); rows[0].lifetimeUsage.inputTokens = 99;
  const body = rows.map(JSON.stringify).join('\n') + '\n'; writeFileSync(index, body);
  assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, f.input), { code: 'USAGE_LEDGER_CONFLICT' });
  assert.equal(readFileSync(index, 'utf8'), body);
  intent.schemaVersion = 999; writeFileSync(f.intent, JSON.stringify(intent));
  assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, f.input), { code: 'USAGE_LEDGER_INVALID' });
});
test('conflicting turn identity, malformed UTF8, unsafe amount and oversized line preserve prior state', () => {
  const f = fixture(); f.store.recordRuntimeTurnUsage(f.meta.id, f.input);
  const body = readFileSync(f.ledger); const changed = structuredClone(f.input); changed.usage.inputTokens = 20;
  assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, changed), { code: 'USAGE_LEDGER_CONFLICT' });
  changed.attribution.id = 'invalid'; changed.usage.inputTokens = Number.MAX_SAFE_INTEGER;
  assert.throws(() => f.store.recordRuntimeTurnUsage(f.meta.id, changed), { code: 'USAGE_LEDGER_INVALID' });
  assert.deepEqual(readFileSync(f.ledger), body);
  writeFileSync(f.ledger, Buffer.from([0xff, 10])); assert.throws(() => scanUsageLedger(f.ledger, '', ''), { code: 'USAGE_LEDGER_INVALID' });
  writeFileSync(f.ledger, 'x'.repeat(262145)); assert.throws(() => scanUsageLedger(f.ledger, '', ''), { code: 'USAGE_LEDGER_LIMIT' });
});
test('model attribution keys cannot inherit JavaScript prototype entries', () => {
  const f = fixture(); f.input.attribution.modelProviderId = '__proto__';
  const saved = f.store.recordRuntimeTurnUsage(f.meta.id, f.input);
  assert.equal(Object.hasOwn(saved.lifetimeUsage.byModel, '__proto__'), true);
  assert.equal(saved.lifetimeUsage.byModel.__proto__.inputTokens, 10);
});
test('non-ASCII invalid bytes cannot be mistaken for a blank ledger line', () => {
  const f=fixture(); writeFileSync(f.ledger,Buffer.from([0xa0,10]));
  assert.throws(()=>scanUsageLedger(f.ledger,'',''),{code:'USAGE_LEDGER_INVALID'});
});
test('an unexpected BOM is preserved and rejected, rather than silently decoded away', () => {
  const f=fixture();writeFileSync(f.ledger,'\ufeff{"id":"foreign"}\n');
  assert.throws(()=>scanUsageLedger(f.ledger,'',''),{code:'USAGE_LEDGER_INVALID'});
});
test('unpaired JSON surrogate escapes fail closed at the shared-data seam', () => {
  const f=fixture();writeFileSync(f.ledger,'{"id":"\\ud800"}\n');
  assert.throws(()=>scanUsageLedger(f.ledger,'',''),{code:'USAGE_LEDGER_INVALID'});
});
