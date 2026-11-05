import assert from 'node:assert/strict';
import test from 'node:test';
import type { InteractiveResultReference, InteractiveResultsApi, InteractiveVersionNavigation } from '@peer-agent/protocol';
import { createVersionNavigationSession } from './versionNavigationSession.ts';

const reference: InteractiveResultReference = { owner: { workspaceId: 'bot', conversationId: 'parent' }, resultId: 'result', contentVersion: `sha256:${'a'.repeat(64)}` };
const head = { ...reference, contentVersion: `sha256:${'b'.repeat(64)}` }, predecessor = { ...reference, contentVersion: `sha256:${'c'.repeat(64)}` };
const handle = { viewId: 'view', windowId: 'window', generation: 'generation' };
const versions = { reference, head, predecessor };
const api = (readVersions: InteractiveResultsApi['readVersions']) => ({ readVersions }) as InteractiveResultsApi;

test('version navigation uses only checked fixed references, deduplicates work and never substitutes the active view', async () => {
  const opened: InteractiveResultReference[] = []; let reads = 0;
  const session = createVersionNavigationSession({ reference, handle, api: api(async request => {
    reads++; assert.deepEqual(request, { handle }); return { ok: true, versions };
  }), openReference: ref => { opened.push(ref); return true; } });
  assert.equal(await session.open('head'), false); assert.equal(opened.length, 0);
  const checking = session.check(); assert.equal(session.check(), checking); assert.equal(await checking, true); assert.equal(reads, 1);
  const opening = session.open('head'); assert.equal(await session.open('head'), false); assert.equal(await opening, true);
  assert.deepEqual(opened, [head]); assert.deepEqual(session.snapshot().versions?.reference, reference);
  assert.equal(await session.open('predecessor'), true); assert.deepEqual(opened, [head, predecessor]);
});

test('foreign, malformed and late version receipts cannot navigate and an unavailable bridge leaves the view recoverable', async () => {
  for (const invalid of [{ ...versions, head: { ...head, owner: { ...head.owner, workspaceId: 'other' } } },
    { ...versions, reference: head }, { ...versions, predecessor: reference }, { ...versions, head: { ...head, resultId: 'other' } }]) {
    const session = createVersionNavigationSession({ reference, handle, api: api(async () => ({ ok: true, versions: invalid })) });
    assert.equal(await session.check(), false); assert.equal(session.snapshot().error, 'interactive_version_receipt_invalid');
    assert.equal(await session.open('head'), false);
  }
  let finish!: (value: { ok: true; versions: InteractiveVersionNavigation }) => void;
  const session = createVersionNavigationSession({ reference, handle, api: api(() => new Promise(resolve => { finish = resolve; })) });
  const pending = session.check(); await Promise.resolve(); session.dispose();
  const unsubscribe = session.subscribe(() => {}); // React can re-subscribe after a lifecycle cleanup.
  finish({ ok: true, versions }); assert.equal(await pending, false); assert.equal(session.snapshot().versions, null);
  assert.equal(session.snapshot().phase, 'idle');
  const rechecked = session.check(); await Promise.resolve(); finish({ ok: true, versions });
  assert.equal(await rechecked, true); assert.equal(session.snapshot().phase, 'ready');
  unsubscribe(); session.dispose();
  const missing = createVersionNavigationSession({ reference, handle, api: api(undefined) });
  assert.equal(await missing.check(), false); assert.equal(missing.snapshot().error, 'interactive_navigation_unavailable');
});

test('native version opening sends its exact relation and target; conflicts clear the candidate and never retry with latest', async () => {
  let calls = 0;
  const bridge = { ...api(async () => ({ ok: true, versions })), openVersion: async (request: unknown) => {
    calls++; assert.deepEqual(request, { handle, relation: 'head', expectedReference: head }); return { ok: false, code: 'version_conflict' };
  } } as InteractiveResultsApi;
  const session = createVersionNavigationSession({ reference, handle, api: bridge });
  assert.equal(await session.check(), true); assert.equal(await session.open('head'), false);
  assert.equal(session.snapshot().error, 'version_conflict'); assert.equal(session.snapshot().versions, null);
  assert.equal(await session.open('head'), false); assert.equal(calls, 1);
});
