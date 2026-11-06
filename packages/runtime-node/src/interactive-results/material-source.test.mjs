import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJSON } from '@peer-agent/interactive-content';
import { createInteractiveMaterialSource } from './material-source.mjs';

const now = () => '2026-11-03T00:00:00.000Z';
const value = { rows: Array.from({ length: 110 }, (_, id) => ({ id, cost: id + 1, label: `Row ${id}` })) };
const hash = data => `sha256:${createHash('sha256').update(canonicalJSON(data)).digest('hex')}`;
const source = { kind: 'tool-result', conversationId: 'worker', toolCallId: 'read-a', expectedContentVersion: hash(value) };
const record = { canonical: true, available: true, value, contentVersion: hash(value), observedAt: now(), truncated: false, redacted: true, dataLevel: 'D3_private', evidenceRefs: ['tool-result://read-a'] };
const input = { bindingId: 'rows', source, selector: { path: ['rows'], fields: ['id', 'cost'], start: 100, limit: 2 } };

test('material resolution uses actual complete canonical bytes, scoped selection, time and inherited privacy', async () => {
  let checks = 0, reads = 0;
  const reader = createInteractiveMaterialSource({ admitSource: async (s, context) => { checks++; return s.conversationId === context.conversationId; },
    readToolResult: async () => { reads++; return record; }, now });
  const result = await reader.resolveInputs([input], { conversationId: 'worker' });
  assert.deepEqual(result.bindings.rows, [{ id: 100, cost: 101 }, { id: 101, cost: 102 }]);
  assert.equal(result.dataLevel, 'D3_private');
  assert.equal(result.provenance[0].selectedDigest, hash(result.bindings.rows));
  assert.equal(result.provenance[0].redacted, true);
  assert.equal(result.provenance[0].truncated, false);
  assert.equal(checks, 1); assert.equal(reads, 1);
});

test('missing admission and wrong work reject before the canonical body is read', async () => {
  let reads = 0;
  const reader = createInteractiveMaterialSource({ admitSource: () => false, readToolResult: () => { reads++; return record; } });
  await assert.rejects(reader.resolveInputs([input], { conversationId: 'other' }), { code: 'material_scope_denied' });
  assert.equal(reads, 0);
  await assert.rejects(createInteractiveMaterialSource().resolveInputs([input], {}), { code: 'material_scope_denied' });
});

test('canonical data tampering, wrong version, unavailable full body and unknown classification fail closed', async () => {
  for (const [patch, code] of [
    [{ value: { rows: [{ id: 0, cost: 999 }] } }, 'material_version_mismatch'],
    [{ contentVersion: 'sha256:' + '0'.repeat(64) }, 'material_version_mismatch'],
    [{ canonical: false }, 'material_snapshot_unavailable'],
    [{ available: false }, 'material_snapshot_unavailable'],
    [{ dataLevel: undefined }, 'material_classification_unavailable'],
    [{ evidenceRefs: [] }, 'material_snapshot_unavailable'],
  ]) {
    const reader = createInteractiveMaterialSource({ admitSource: () => true, readToolResult: () => ({ ...record, ...patch }) });
    await assert.rejects(reader.resolveInputs([input], {}), { code });
  }
});

test('a truncated preview stays truncated and is never padded into a complete dataset', async () => {
  const preview = { rows: [{ id: 0, cost: 1 }] };
  const version = hash(preview);
  const reader = createInteractiveMaterialSource({ admitSource: () => true,
    readToolResult: () => ({ ...record, value: preview, contentVersion: version, truncated: true }) });
  const result = await reader.resolveInputs([{ bindingId: 'rows', source: { ...source, expectedContentVersion: version }, selector: { path: ['rows'] } }], {});
  assert.equal(result.provenance[0].truncated, true);
  assert.equal(result.bindings.rows.length, 1);
  await assert.rejects(reader.resolveInputs([{ ...input, source: { ...source, expectedContentVersion: version } }], {}), { code: 'material_range_exceeded' });
});

test('model data remains model-constructed, inherits privacy and retains a digest rather than a second large body', async () => {
  const reader = createInteractiveMaterialSource({ now });
  const result = await reader.resolveInputs([{ bindingId: 'rows', source: { kind: 'model-data', value: value.rows } }], {}, { inheritedDataLevel: 'D4_regulated' });
  assert.equal(result.dataLevel, 'D4_regulated');
  assert.deepEqual(result.provenance[0].source, { kind: 'model-data', contentDigest: hash(value.rows) });
  assert.deepEqual(result.provenance[0].evidenceRefs, []);
});

test('cancellation after asynchronous admission does not read or emit a snapshot', async () => {
  const controller = new AbortController(); let reads = 0;
  const reader = createInteractiveMaterialSource({ admitSource: () => { controller.abort(); return true; }, readToolResult: () => { reads++; return record; } });
  await assert.rejects(reader.resolveInputs([input], {}, { signal: controller.signal }), { code: 'interactive_cancelled' });
  assert.equal(reads, 0);
});

test('own-field selection never follows prototypes, evaluates JSONPath or silently omits a missing field', async () => {
  const reader = createInteractiveMaterialSource({ admitSource: () => true, readToolResult: () => record });
  for (const selector of [{ path: ['constructor'] }, { path: ['$.rows'] }, { path: ['rows'], fields: ['missing'] }]) {
    await assert.rejects(reader.resolveInputs([{ ...input, selector }], {}), { code: 'material_range_exceeded' });
  }
});
