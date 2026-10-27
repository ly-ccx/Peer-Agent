import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocumentVersionReader, normalizeDocumentObservation, type ObservedDocumentRead } from './documentObservationState.ts';

const observation = { sourceId: `sha256:${'a'.repeat(64)}`, resourceId: `sha256:${'b'.repeat(64)}`, contentVersion: `sha256:${'c'.repeat(64)}`, relativePath: 'guide.md' };
const changed = { ...observation, contentVersion: `sha256:${'d'.repeat(64)}` };

test('refresh preserves the accepted reading; explicit adoption relaxes content version but never resource identity', async () => {
  const expected: unknown[] = [];
  let next: ObservedDocumentRead = { ok: true, status: 'ok', content: 'old body', observation };
  const reader = createDocumentVersionReader(async request => { expected.push(request); return next; });
  assert.equal(await reader.reload(), true);
  next = { ok: false, status: 'version_changed', content: '', observation: changed };
  assert.equal(await reader.reload(), false); assert.equal(reader.snapshot().value?.content, 'old body');
  assert.deepEqual(expected[1], { resourceId: observation.resourceId, contentVersion: observation.contentVersion });
  next = { ok: true, status: 'ok', content: 'new body', observation: changed };
  assert.equal(await reader.loadCurrent(), true); assert.deepEqual(expected[2], { resourceId: observation.resourceId });
  assert.equal(reader.snapshot().value?.content, 'new body'); assert.equal(reader.snapshot().failure, null);
});

test('restored hashes are not saved bodies; old hosts, forged successes and new sources fail closed', async () => {
  const reader = createDocumentVersionReader(async () => ({ ok: true, status: 'ok', content: 'unexpected new source', observation: { ...changed, resourceId: `sha256:${'e'.repeat(64)}` } }), observation);
  assert.equal(await reader.loadCurrent(), false); assert.equal(reader.snapshot().value, null);
  assert.equal(reader.snapshot().failure?.status, 'source_changed'); assert.equal(reader.snapshot().failure?.content, '');
  const legacy = createDocumentVersionReader(async () => ({ ok: true, status: 'ok', content: 'unversioned' }));
  assert.equal(await legacy.reload(), false); assert.equal(legacy.snapshot().failure?.status, 'version_unavailable');
  assert.equal(normalizeDocumentObservation({ ...observation, relativePath: '../secret' }), undefined);
  assert.equal(normalizeDocumentObservation({ ...observation, contentVersion: 'mtime:123' }), undefined);
});

test('cancellation retires delayed reads and failures preserve accepted content', async () => {
  let resolve!: (value: ObservedDocumentRead) => void;
  let fail = false;
  const reader = createDocumentVersionReader<ObservedDocumentRead>(() => fail ? Promise.reject(Error('offline')) : new Promise(done => { resolve = done; }));
  const first = reader.reload(); reader.cancel(); resolve({ ok: true, status: 'ok', content: 'retired', observation }); await first;
  assert.equal(reader.snapshot().value, null);
  const fresh = reader.reload(); resolve({ ok: true, status: 'ok', content: 'accepted', observation }); await fresh;
  fail = true; assert.equal(await reader.reload(), false); assert.equal(reader.snapshot().error, true);
  assert.equal(reader.snapshot().value?.content, 'accepted');
});
