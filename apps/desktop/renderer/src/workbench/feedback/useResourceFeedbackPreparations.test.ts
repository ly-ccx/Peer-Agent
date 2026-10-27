import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as protocol from '@peer-agent/protocol';
const hash = `sha256:${'a'.repeat(64)}`;
const feedback = { id: 'quote', recipient: { workspaceId: 'bot', conversationId: 'main' }, capturedAt: '2026-10-27T00:00:00Z',
  resource: { kind: 'document', mode: 'preview', reference: { workspaceId: 'bot', path: '/repo/a.md' } },
  version: { kind: 'content', resourceId: hash, contentVersion: hash }, excerpt: 'selected text', selection: { kind: 'discussion' } };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let receive: any, cleanup: any, claim: any = { ok: true, id: 'quote' }, prepare: any = { ok: true }, unsubscribed = false;
  const calls: any[] = [], api = {
    onResourceFeedbackPreparation: (callback: any) => { receive = callback; return () => { unsubscribed = true; }; },
    claimResourceFeedbackPreparation: async (key: any) => { calls.push(['claim', key]); return claim; },
    acknowledgeResourceFeedbackPreparation: async (payload: any) => { calls.push(['ack', payload]); return { ok: true }; },
  };
  const exports: any = {};
  runInNewContext(ts.transpileModule(readFileSync(new URL('./useResourceFeedbackPreparations.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { exports, Date, window: { peerAgent: api }, require(id: string) {
      if (id === 'react') return { useEffect: (effect: any) => { cleanup = effect(); } };
      if (id === '@peer-agent/protocol') return protocol;
      if (id === './feedbackDraft') return { prepareResourceFeedbackDraft: async (row: any) => { calls.push(['persist', row]); return prepare; } };
      throw Error(id);
    } });
  exports.useResourceFeedbackPreparations();
  const request = { requestId: 'request', identity: { viewId: 'view', windowId: 'window', generation: 1 }, feedback, expiresAt: Date.now() + 3000 };
  return { calls, receive: (value: any = request) => receive(value), request,
    deny: () => { claim = { ok: false, code: 'SOURCE_CHANGED' }; }, fail: () => { prepare = { ok: false, code: 'DRAFT_SAVE_FAILED' }; },
    cleanup: () => cleanup(), unsubscribed: () => unsubscribed };
}
test('native request must claim first and only durable draft receipt acknowledges success; no send or switch ports', async () => {
  const h = fixture(); h.receive(); h.receive(); await tick();
  assert.deepEqual(h.calls.map(call => call[0]), ['claim', 'persist', 'ack']);
  assert.equal(h.calls[1][1].recipient.conversationId, 'main'); assert.equal(h.calls[2][1].ok, true);
  assert.equal(h.calls[2][1].feedbackId, 'quote'); assert.equal(h.calls[2][1].identity.windowId, 'window');
  h.cleanup(); assert.equal(h.unsubscribed(), true);
});
test('denied or expired claim never persists; save failure is not represented as a prepared draft', async () => {
  const h = fixture(); h.deny(); h.receive(); await tick(); assert.deepEqual(h.calls.map(call => call[0]), ['claim', 'ack']);
  assert.equal(h.calls[1][1].code, 'SOURCE_CHANGED');
  const j = fixture(); j.fail(); j.receive(); await tick(); assert.equal(j.calls.at(-1)[1].ok, false); assert.equal(j.calls.at(-1)[1].code, 'DRAFT_SAVE_FAILED');
  const k = fixture(); k.receive({ ...k.request, expiresAt: Date.now() - 1 }); await tick(); assert.equal(k.calls.length, 0);
});
test('unmounted source cannot begin a new persistence after claim or manufacture a late acknowledgement', async () => {
  const h = fixture(); h.receive(); h.cleanup(); await tick(); assert.deepEqual(h.calls.map(call => call[0]), ['claim']);
});
