import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createResourceFeedbackPreparation } from './resource-feedback-preparation.mjs';
const identity = { viewId: 'view', windowId: 'window', generation: 1 };
const hash = `sha256:${'a'.repeat(64)}`;
const feedback = { id: 'quote', recipient: { workspaceId: 'bot', conversationId: 'main' }, capturedAt: '2026-10-27T00:00:00Z',
  resource: { kind: 'document', mode: 'preview', reference: { workspaceId: 'bot', path: '/repo/a.md' } },
  version: { kind: 'content', resourceId: hash, contentVersion: hash }, excerpt: 'quoted text', selection: { kind: 'discussion' } };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const source = new EventEmitter(), messages = [], timers = new Map(); let sequence = 0, now = 0, recipient = 'main', current = true;
  source.isDestroyed = () => false; source.send = (channel, value) => messages.push({ channel, value });
  const host = createResourceFeedbackPreparation({ isMainSender: sender => sender === source,
    getRecipient: () => ({ conversationId: recipient }), now: () => now, createId: () => `request-${++sequence}`,
    schedule: fn => { const id = Symbol(); timers.set(id, fn); return id; }, cancel: id => timers.delete(id) });
  const begin = (row = feedback) => host.prepare({ sourceSender: source, identity, feedback: row, isCurrent: () => current });
  const key = (i = 0) => { const r = messages[i].value; return { requestId: r.requestId, identity: r.identity, feedbackId: r.feedback.id }; };
  return { source, messages, timers, host, begin, key, change: () => { current = false; }, recipient: id => { recipient = id; }, advance: () => { now += 3001; [...timers.values()].forEach(fn => fn()); } };
}
test('only actual source sender and exact identity can claim and confirm a durable draft', async () => {
  const h = fixture(), pending = h.begin(); await tick(); const key = h.key();
  assert.equal(h.messages[0].channel, 'resource-feedback:prepare');
  assert.equal((await h.host.claim(new EventEmitter(), key)).ok, false);
  assert.equal((await h.host.claim(h.source, { ...key, identity: { ...identity, generation: 2 } })).ok, false);
  assert.equal((await h.host.acknowledge(h.source, { ...key, ok: true })).ok, false);
  assert.equal((await h.host.claim(h.source, key)).ok, true);
  assert.equal((await h.host.acknowledge(h.source, { ...key, ok: true })).ok, true);
  assert.deepEqual(await pending, { ok: true, id: 'quote' }); assert.equal(h.timers.size, 0);
  assert.equal(h.source.listenerCount('destroyed'), 0);
  assert.equal((await h.host.acknowledge(h.source, { ...key, ok: true })).ok, false);
});
test('source changes before claim fail; after claim captured material survives navigation', async () => {
  const h = fixture(), pending = h.begin(); await tick(); h.change();
  assert.equal((await h.host.claim(h.source, h.key())).code, 'SOURCE_CHANGED'); assert.equal((await pending).code, 'SOURCE_CHANGED');
  const j = fixture(), kept = j.begin(); await tick(); await j.host.claim(j.source, j.key()); j.change();
  await j.host.acknowledge(j.source, { ...j.key(), ok: true }); assert.equal((await kept).ok, true);
});
test('recipient replacement cannot redirect a pending reference; timeout never claims saved or resends', async () => {
  const h = fixture(), pending = h.begin(); await tick(); h.recipient('new-main');
  assert.equal((await h.host.claim(h.source, h.key())).code, 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED');
  assert.equal((await pending).code, 'RESOURCE_FEEDBACK_RECIPIENT_CHANGED');
  const j = fixture(), unknown = j.begin(); await tick(); await j.host.claim(j.source, j.key()); j.advance();
  assert.equal((await unknown).code, 'DRAFT_PREPARATION_UNCONFIRMED');
  assert.equal((await j.host.acknowledge(j.source, { ...j.key(), ok: true })).ok, false); assert.equal(j.messages.length, 1);
});
test('same quote coalesces while collisions, limits, destroyed senders and disposal retire cleanly', async () => {
  const h = fixture(), first = h.begin(), same = h.begin(); await tick(); assert.equal(h.messages.length, 1);
  assert.equal((await h.begin({ ...feedback, excerpt: 'changed' })).code, 'RESOURCE_FEEDBACK_ID_CONFLICT');
  const rest = Array.from({ length: 7 }, (_, i) => h.begin({ ...feedback, id: `quote-${i}` })); await tick();
  assert.equal((await h.begin({ ...feedback, id: 'overflow' })).code, 'RESOURCE_FEEDBACK_LIMIT');
  h.source.emit('destroyed'); assert.equal((await first).code, 'SOURCE_UNAVAILABLE'); assert.equal((await same).code, 'SOURCE_UNAVAILABLE');
  assert.ok((await Promise.all(rest)).every(row => row.code === 'SOURCE_UNAVAILABLE')); assert.equal(h.timers.size, 0);
  const j = fixture(), disposed = j.begin(); await tick(); j.host.dispose(); assert.equal((await disposed).code, 'SOURCE_UNAVAILABLE');
});
