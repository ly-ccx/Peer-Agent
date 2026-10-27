import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResourceWindowContext, ResourceWindowResult } from '@peer-agent/protocol';
import type { ResourceWindowApi } from '../preload/contracts/resourceWindowApi';
import { createNativeNavigation } from './nativeNavigationState.ts';
const context: ResourceWindowContext = { viewId: 'view', windowId: 'window', generation: 1, navigationVersion: 0, phase: 'ready', owner: { workspaceId: 'bot', conversationId: 'conversation' },
  resource: { kind: 'document', reference: { workspaceId: 'bot', path: '/repo/a.md' }, mode: 'preview' }, navigation: { top: 10, left: 0 } };
test('checkpoint sending is serialized; a return/close flush includes geometry captured after an older in-flight packet', async () => {
  const calls: any[] = []; const finish: ((result: ResourceWindowResult) => void)[] = [];
  const api = { navigation: (request: any) => { calls.push(request); return new Promise<ResourceWindowResult>(resolve => finish.push(resolve)); } } as ResourceWindowApi;
  const store = createNativeNavigation(context, api);
  try {
    store.update({ top: 100, left: 0 }); const first = store.flush(); await Promise.resolve();
    let top = 900; store.registerCapture(() => ({ top, left: 0, mode: 'source' }));
    const last = store.flush(); assert.equal(calls.length, 1);
    finish[0]({ ok: true, context: { ...context, navigationVersion: 1 }, persisted: true }); await first; await Promise.resolve(); await Promise.resolve();
    assert.equal(calls[1].sequence, 2); assert.equal(calls[1].navigation.top, 900);
    finish[1]({ ok: true, context: { ...context, navigationVersion: 2 }, persisted: true }); assert.equal(await last, true);
    top = 1200; assert.equal(store.current().top, 900); // No hidden polling/capture.
  } finally { store.stop(); }
});
test('failed persistence remains visible and a synchronous transport failure can be retried with a fresh sequence', async () => {
  let fail = true, sequence = 0;
  const api = { navigation: (request: any) => { if (fail) throw Error('disconnected'); sequence = request.sequence; return Promise.resolve({ ok: true, context: { ...context, navigationVersion: sequence }, persisted: sequence > 1 }); },
    bootstrap: async () => ({ ok: true, context: { ...context, navigationVersion: sequence } }) } as ResourceWindowApi;
  const store = createNativeNavigation(context, api);
  try {
    assert.equal(await store.flush(), false); assert.equal(store.snapshot().persisted, false);
    fail = false; assert.equal(await store.retry(), false); assert.equal(store.snapshot().error, 'storage_unavailable');
    assert.equal(await store.retry(), true); assert.equal(sequence, 2); assert.equal(store.snapshot().persisted, true);
  } finally { store.stop(); }
});
