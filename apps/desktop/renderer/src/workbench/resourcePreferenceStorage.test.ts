import assert from 'node:assert/strict';
import test from 'node:test';
import { readLegacyResourcePreferences, writeLegacyResourcePreferences } from './resourcePreferenceStorage.ts';
const owner = 'parent-a', key = `peer.resource-workspace.v1:${owner}`;
const legacy = { order: ['document:a', 'comparison:workspace', 'browser:b'], recent: [JSON.stringify({ kind: 'document', path: '/repo/a.md' })] };
function storage(body: string | null = null) {
  const records = new Map<string, string>(body === null ? [] : [[key, body]]);
  return { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); } };
}
test('known legacy preferences still save without a new result or storage migration', () => {
  const port = storage();
  assert.equal(readLegacyResourcePreferences(owner, port).valid, true);
  assert.equal(writeLegacyResourcePreferences(owner, legacy, port), true);
  assert.deepEqual(readLegacyResourcePreferences(owner, port), { valid: true, value: legacy });
});
test('existing new result references, unknown versions and corrupt records survive old-format writes byte for byte', () => {
  for (const body of [
    JSON.stringify({ ...legacy, order: ['interactive:fixed'] }),
    JSON.stringify({ ...legacy, recent: [JSON.stringify({ kind: 'interactive', reference: { resultId: 'fixed' } })] }),
    JSON.stringify({ ...legacy, formatVersion: 2, interactive: { tabs: [] } }),
    JSON.stringify({ ...legacy, recent: [JSON.stringify({ kind: 'future-resource', identity: 'fixed' })] }),
    '{broken',
  ]) {
    const port = storage(body);
    assert.equal(readLegacyResourcePreferences(owner, port).valid, false);
    assert.equal(writeLegacyResourcePreferences(owner, legacy, port), false);
    assert.equal(port.getItem(key), body);
  }
});
test('the legacy adapter refuses incoming new references, unbounded or unknown fields without rewriting a valid row', () => {
  const body = JSON.stringify(legacy), port = storage(body);
  for (const value of [
    { ...legacy, order: ['interactive:fixed'] },
    { ...legacy, recent: [JSON.stringify({ kind: 'interactive', reference: { resultId: 'fixed' } })] },
    { ...legacy, writer: 'fake' },
    { ...legacy, recent: Array.from({ length: 17 }, () => 'document:a') },
    { ...legacy, order: ['document:' + 'x'.repeat(8192)] },
  ]) {
    assert.equal(writeLegacyResourcePreferences(owner, value, port), false);
    assert.equal(port.getItem(key), body);
  }
});
