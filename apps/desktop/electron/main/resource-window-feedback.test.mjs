import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceWindowFeedback } from './resource-window-feedback.mjs';
const identity = { viewId: 'view', windowId: 'window', generation: 1 }, hash = `sha256:${'a'.repeat(64)}`;
const reference = { workspaceId: 'bot', kind: 'file', path: '/repo/a.md', task: { sessionId: 'task', planId: 'plan' } };
const document = { kind: 'document', mode: 'preview', reference };
const row = resource => ({ id: 'quote', recipient: { workspaceId: 'bot', conversationId: 'main' }, capturedAt: '2026-10-27T00:00:00Z', resource,
  version: resource.kind === 'directory' ? { kind: 'directory-list', digest: hash } : resource.kind === 'comparison' ? { kind: 'comparison', digest: hash }
    : { kind: 'content', resourceId: hash, contentVersion: hash }, excerpt: 'already selected', selection: { kind: 'discussion' } });
function fixture(original = document) {
  const sender = {}, sourceSender = {}, calls = []; let live = true, root = '/repo', resolvedTarget;
  const scope = { root, target: original.reference.path }, context = { ...identity, owner: { workspaceId: 'bot', conversationId: 'main' }, resource: original };
  const handler = createResourceWindowFeedback({ registry: { readBinding: (wc, key) => wc === sender && live && key.generation === 1 ? { ok: true, context } : { ok: false },
    returnTarget: () => ({ ok: true, sourceSender }) }, getScope: () => scope,
    reader: { prepare: async resource => ({ ok: true, owner: context.owner, root, target: resolvedTarget ?? resource.reference.path }) },
    prepare: async request => { calls.push(request); return { ok: true, id: request.feedback.id }; } });
  return { sender, sourceSender, calls, handler, close: () => { live = false; }, move: value => { resolvedTarget = value; }, root: value => { root = value; } };
}
test('native quote uses original main sender and read lease; the claim validator checks live scope again', async () => {
  const h = fixture(); assert.equal((await h.handler(h.sender, { identity, feedback: row(document) })).ok, true);
  assert.equal(h.calls[0].sourceSender, h.sourceSender); assert.deepEqual(h.calls[0].identity, identity);
  assert.equal(await h.calls[0].isCurrent(), true); h.close(); assert.equal(await h.calls[0].isCurrent(), false);
});
test('wrong sender, recipient, task, physical target, root or resource semantics cannot cross a lease', async () => {
  const h = fixture(); assert.equal((await h.handler({}, { identity, feedback: row(document) })).ok, false);
  const cases = [{ ...row(document), recipient: { workspaceId: 'another', conversationId: 'main' } }, row({ ...document, reference: { ...reference, task: { sessionId: 'other', planId: 'plan' } } }),
    row({ ...document, reference: { ...reference, path: '/repo/b.md' } }), row({ kind: 'directory', reference: { ...reference, kind: 'directory' } })];
  for (const feedback of cases) assert.equal((await h.handler(h.sender, { identity, feedback })).ok, false);
  h.root('/other'); assert.equal((await h.handler(h.sender, { identity, feedback: row(document) })).ok, false); assert.equal(h.calls.length, 0);
});
test('directory descendant quote is allowed without broadening to siblings or mutable comparison baselines', async () => {
  const original = { kind: 'directory', reference: { ...reference, kind: 'directory', path: '/repo/docs' } }, h = fixture(original);
  assert.equal((await h.handler(h.sender, { identity, feedback: row({ ...document, reference: { ...reference, path: '/repo/docs/a.md' } }) })).ok, true);
  h.move('/repo/docs-other/a.md'); assert.equal((await h.handler(h.sender, { identity, feedback: row(document) })).ok, false);
  const comparison = { kind: 'comparison', reference: { ...reference, kind: 'directory', path: '/repo' }, fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) }, j = fixture(comparison);
  assert.equal((await j.handler(j.sender, { identity, feedback: row({ ...comparison, toRef: 'c'.repeat(40) }) })).ok, false);
  assert.equal((await j.handler(j.sender, { identity, feedback: row(comparison) })).ok, true);
});
