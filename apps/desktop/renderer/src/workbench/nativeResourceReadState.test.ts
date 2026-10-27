import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResourceWindowReadResult } from '@peer-agent/protocol';
import { createNativeResourceReader } from './nativeResourceReadState.ts';

const hash = (char: string) => 'sha256:' + char.repeat(64);
const observation = { sourceId: hash('a'), resourceId: hash('b'), contentVersion: hash('c'), relativePath: 'a.md' };
const value: ResourceWindowReadResult = { ok: true, status: 'ok', document: { ok: true, status: 'ok', content: 'accepted', media: 'text', observation } };
const request = { identity: { viewId: 'view', windowId: 'window', generation: 1 }, operation: 'content' as const };
test('failed refresh retains old content and only explicit adoption removes its content condition', async () => {
  const calls: any[] = []; let next = value;
  const reader = createNativeResourceReader(request, async request => { calls.push(request); return next; });
  await reader.reload(); next = { ok: false, status: 'version_changed' }; await reader.reload();
  assert.equal(reader.snapshot().value?.document?.content, 'accepted'); assert.equal(reader.snapshot().failure, 'version_changed');
  assert.equal(calls.at(-1).expectedObservation.contentVersion, observation.contentVersion);
  next = value; await reader.loadCurrent(); assert.equal(calls.at(-1).loadCurrent, true);
  assert.deepEqual(calls.at(-1).expectedObservation, { resourceId: observation.resourceId });
});
test('cancelled or superseded reads never replace an accepted reading', async () => {
  let finish!: (value: ResourceWindowReadResult) => void;
  const reader = createNativeResourceReader(request, () => new Promise(resolve => { finish = resolve; }));
  const pending = reader.reload(); reader.cancel(); finish(value); assert.equal(await pending, false); assert.equal(reader.snapshot().value, null);
  const first = reader.reload(), stale = finish, latest = reader.reload(); finish(value); await latest;
  stale({ ok: false, status: 'permission_denied' }); await first;
  assert.equal(reader.snapshot().value?.document?.content, 'accepted'); assert.equal(reader.snapshot().failure, null);
});
test('missing or mismatched version receipts cannot masquerade as an accepted read', async () => {
  let next = value;
  const reader = createNativeResourceReader(request, async () => next); await reader.reload();
  next = { ...value, document: { ...value.document!, observation: undefined } }; await reader.reload();
  assert.equal(reader.snapshot().failure, 'version_unavailable'); assert.equal(reader.snapshot().value, value);
  next = { ...value, document: { ...value.document!, observation: { ...observation, resourceId: hash('d') } } }; await reader.loadCurrent();
  assert.equal(reader.snapshot().failure, 'source_changed'); assert.equal(reader.snapshot().value, value);
});
