import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import type { ResourceEditsApi, ResourceEditSource } from '@peer-agent/protocol';
import { createResourceEditRegistry } from './resourceEditRegistry.ts';
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const source: ResourceEditSource = { kind: 'document', reference: { workspaceId: 'bot', path: '/repo/a.md' }, observed: { resourceId: hash('id'), contentVersion: hash('base') } };
const draft = { id: 'draft', target: { recipient: { workspaceId: 'bot', conversationId: 'conversation' }, reference: source.reference, base: source.observed }, baseText: 'base', text: 'base', revision: 0, createdAt: '2026-10-27T01:00:00Z', updatedAt: '2026-10-27T01:00:00Z' };
const handle = { viewId: 'view', windowId: 'window', generation: 1, draftId: 'draft' };
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  let opens = 0; const closes: unknown[] = [];
  const api = { open: async () => { opens++; return { ok: true, draft, handle }; }, resume: async () => ({ ok: true, draft, handle }), close: async (value: unknown) => { closes.push(value); return { ok: true }; } } as unknown as ResourceEditsApi;
  return { registry: createResourceEditRegistry(api), opens: () => opens, closes };
}
test('duplicate source clicks coalesce host opens; locator mismatch cannot reuse a different local target', async () => {
  const f = fixture(), [a, b] = await Promise.all([f.registry.openSource(source), f.registry.openSource(source)]);
  assert.ok(a); assert.equal(a, b); assert.equal(f.opens(), 1);
  assert.equal(f.registry.get('bot', 'draft', { expectedPath: '/other.md' }), null); assert.equal(f.registry.error(), 'RESOURCE_EDIT_SOURCE_CHANGED');
});
test('strict-mode detach and immediate reattach do not release a live editing view; real detach preserves saved intent', async () => {
  const f = fixture(), session = await f.registry.openSource(source); assert.ok(session);
  const detach = f.registry.attach(session); detach(); const detachAgain = f.registry.attach(session); await tick();
  assert.equal(f.closes.length, 0); assert.ok(session.snapshot().view);
  detachAgain(); await tick(); assert.equal(f.closes.length, 1); assert.equal(session.snapshot().text, 'base'); assert.equal(session.snapshot().view, null);
});
test('bounded registry never evicts an unsaved local buffer to admit another view', () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) { const session = f.registry.get('bot', `draft-${i}`); assert.ok(session); session.edit(`unsaved-${i}`); }
  assert.equal(f.registry.get('bot', 'extra'), null); assert.equal(f.registry.list().length, 32); assert.equal(f.registry.hasUnsafe(), true);
  assert.equal(f.registry.list()[0].session.snapshot().text, 'unsaved-0');
});
