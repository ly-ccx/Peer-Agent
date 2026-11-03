import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test, { type TestContext } from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore, createInteractiveStateStore, createInteractiveViewService } from '@peer-agent/runtime-node/interactive-results';
import type { InteractiveResultsApi } from '@peer-agent/protocol';
import { createInteractiveSessionRegistry } from './interactiveSessionRegistry.ts';

async function fixture(t: TestContext) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-registry-'))), owner = { workspaceId: 'bot-a', conversationId: 'parent-a' };
  const results = createInteractiveResultStore({ rootDir, assertCompatibility: () => true }), states = createInteractiveStateStore({ resultStore: results });
  const draft = { publication: { kind: 'create' as const }, title: 'Trial', textFallback: 'Unverified saved summary.', inputs: [],
    program: '$x=2\nroot=Col([NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x)])' };
  const receipt = results.commitPublication({ owner, source: { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' },
    draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish-a', grantId: 'grant-a', granted: true } }, () => true);
  results.markIndexed(receipt.callRef, receipt.indexEntry);
  const sender = new EventEmitter(), service = createInteractiveViewService({ resultStore: results, stateStore: states, maxViews: 1,
    resolveSource: () => ({ owner, assertCurrent: () => true }) });
  const api = Object.fromEntries(['open', 'cancelOpen', 'readState', 'acquire', 'save', 'release', 'prepareFollowup']
    .map(method => [method, async (request: unknown) => (service as unknown as Record<string, (sender: EventEmitter, request: unknown) => unknown>)[method](sender, request)])) as unknown as InteractiveResultsApi;
  const registry = createInteractiveSessionRegistry(api);
  t.after(() => { service.dispose(); states.close(); results.close(); rmSync(rootDir, { recursive: true, force: true }); });
  return { api, registry, reference: receipt.reference, results, states };
}

test('opening a fixed result coalesces pending requests, preserves domain state across mounts and never takes a writer automatically', async t => {
  const f = await fixture(t), a = f.registry.open(f.reference), b = f.registry.open(f.reference);
  assert.equal(a, b); const entry = await a; assert.equal(entry.phase, 'ready'); assert.ok(entry.session);
  assert.equal(entry.session.snapshot().writer, null);
  assert.equal(entry.session.content.tree?.typeName, 'Col');
  assert.equal(f.registry.hasUnsafe(), false); assert.equal(await f.registry.flushAll(), true);
  await entry.session.acquire(); entry.session.editText('$x', '4');
  assert.equal(f.registry.hasUnsafe(), true); assert.equal(await f.registry.flushAll(), true);
  assert.equal(await f.registry.open(structuredClone(f.reference)), entry);
  assert.equal(entry.session.snapshot().confirmed.values.$x, 4);
  assert.equal(await f.registry.close(f.reference), true); assert.equal(f.registry.list().length, 0);
  const reopened = await f.registry.open(f.reference); assert.ok(reopened.session);
  assert.notEqual(reopened.requestId, entry.requestId); assert.equal(reopened.session.snapshot().confirmed.values.$x, 4);
});

test('a lost open acknowledgement retries its original request instead of leaking a second host view', async t => {
  const f = await fixture(t), open = f.api.open, requests: Parameters<InteractiveResultsApi['open']>[0][] = [];
  let lost = true;
  f.api.open = async request => { requests.push(structuredClone(request)); const reply = await open(request); if (lost) { lost = false; throw Error('ack lost'); } return reply; };
  const first = await f.registry.open(f.reference); assert.equal(first.phase, 'failed');
  const recovered = await f.registry.open(f.reference); assert.equal(recovered.phase, 'ready');
  assert.deepEqual(requests[0], requests[1]); assert.equal(requests.length, 2);
});

test('cancelling an in-flight open frees its domain slot and a late acknowledgement cannot retire the replacement', async t => {
  const f = await fixture(t), original = f.api.open;
  let acknowledge: (() => void) | undefined, delivered: (() => void) | undefined;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  f.api.open = async request => { const reply = await original(request); await new Promise<void>(resolve => { acknowledge = resolve; delivered!(); }); return reply; };
  const pending = f.registry.open(f.reference); await received;
  const firstId = f.registry.get(f.reference)!.requestId;
  assert.equal(await f.registry.flushAll(), false); assert.equal(f.registry.hasUnsafe(), true);
  assert.equal(await f.registry.close(f.reference), true);
  f.api.open = original;
  const replacement = await f.registry.open(f.reference); assert.equal(replacement.phase, 'ready');
  assert.notEqual(replacement.requestId, firstId); assert.ok(replacement.opened);
  acknowledge!(); await pending; await Promise.resolve();
  assert.equal(f.registry.get(f.reference), replacement);
  assert.equal((await f.api.readState({ handle: replacement.opened.handle })).ok, true);
});

test('composition and an unconfirmed save keep the local entry; a later explicit retry saves and closes it', async t => {
  const f = await fixture(t), entry = await f.registry.open(f.reference); assert.ok(entry.session);
  const session = entry.session; await session.acquire(); session.editText('$x', '5', true);
  assert.equal(await f.registry.close(f.reference), false); assert.equal(f.registry.get(f.reference), entry);
  session.editText('$x', '5', false);
  const save = f.api.save; f.api.save = async () => { throw Error('disk or transport unavailable'); };
  assert.equal(await f.registry.close(f.reference), false); assert.equal(session.snapshot().dirty, true);
  assert.equal(f.states.read(f.reference, () => true).stateRevision, 0);
  f.api.save = save; assert.equal(await f.registry.close(f.reference), true);
  assert.equal(f.states.read(f.reference, () => true).values.$x, 5);
});

test('a newer catalog falls back to the fixed saved summary/program and releases its host view without mounting controls', async t => {
  const f = await fixture(t), open = f.api.open;
  f.api.open = async request => { const reply = await open(request); if (!reply.ok) return reply;
    return { ...reply, result: { ...reply.result, content: { ...reply.result.content, libraryVersion: 'future' } } }; };
  const fallback = await f.registry.open(f.reference);
  assert.equal(fallback.phase, 'failed'); assert.equal(fallback.session, undefined);
  assert.equal(fallback.summary?.textFallback, 'Unverified saved summary.'); assert.ok(fallback.opened?.result.content.program);
  f.api.open = open;
  const compatible = await f.registry.open(f.reference); assert.equal(compatible.phase, 'ready');
});

test('an unknown release receipt keeps controls closed until explicit reopen confirms release and creates a fresh view', async t => {
  const f = await fixture(t), entry = await f.registry.open(f.reference); assert.ok(entry.session);
  await entry.session.acquire(); entry.session.editText('$x', '6');
  const release = f.api.release; let lost = true;
  f.api.release = async request => { const reply = await release(request); if (lost) { lost = false; throw Error('release acknowledgement lost'); } return reply; };
  assert.equal(await f.registry.close(f.reference), false);
  assert.equal(entry.session.snapshot().phase, 'closing');
  assert.equal(entry.session.editText('$x', '9'), false);
  const reopened = await f.registry.open(f.reference);
  assert.notEqual(reopened, entry); assert.equal(reopened.phase, 'ready');
  assert.equal(reopened.session?.snapshot().confirmed.values.$x, 6);
});
