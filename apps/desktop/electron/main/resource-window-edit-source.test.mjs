import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceWindowEditSource } from './resource-window-edit-source.mjs';
const observed = { resourceId: `sha256:${'a'.repeat(64)}`, contentVersion: `sha256:${'b'.repeat(64)}` };
function fixture(resource = { kind: 'directory', reference: { workspaceId: 'bot', path: '/repo/docs', task: { sessionId: 'session', planId: 'plan' } } }) {
  const sender = {}, identity = { viewId: 'v', windowId: 'w', generation: 1 }, context = { ...identity, owner: { workspaceId: 'bot', conversationId: 'main' }, resource }, scope = { root: '/repo', target: resource.reference.path }, calls = []; let alive = true, next;
  const host = createResourceWindowEditSource({ registry: { readBinding: (actual, key) => alive && actual === sender && key.generation === 1 ? { ok: true, context } : { ok: false } }, getScope: () => scope,
    reader: { read: async (actual, request) => { calls.push({ actual, request }); return next ?? { ok: true, document: { media: 'text', content: 'raw', resolvedPath: request.path, resolvedFrom: scope.root, observation: observed } }; } } });
  return { host, sender, scope, calls, source: { kind: 'native', identity, path: '/repo/docs/a.md', observed }, expire: () => { alive = false; }, set: value => { next = value; } };
}
test('native source injects existing scope, task and exact observation and permits only a real leased descendant', async () => {
  const f = fixture(), result = await f.host.read(f.sender, f.source); assert.equal(result.ok, true);
  assert.equal(f.calls[0].actual, f.scope); assert.deepEqual(f.calls[0].request.expectedObservation, observed); assert.equal(result.reference.task.sessionId, 'session');
  assert.equal((await f.host.read({}, f.source)).ok, false); assert.equal((await f.host.read(f.sender, { ...f.source, path: '/repo/docs-other/a.md' })).ok, false);
  assert.equal(f.calls.length, 1); f.expire(); assert.equal(f.host.isCurrent(f.sender, f.source), false);
});
test('history, diff, media or expired generations cannot become new writable sources', async () => {
  for (const resource of [{ kind: 'document', mode: 'diff', comparison: 'working', reference: { workspaceId: 'bot', path: '/repo/a.md' } },
    { kind: 'document', mode: 'source', reference: { workspaceId: 'bot', path: '/repo/a.md', revision: { kind: 'git', commit: 'a'.repeat(40) } } }]) {
    const f = fixture(resource); assert.equal(f.host.isCurrent(f.sender, f.source), false); assert.equal(f.calls.length, 0);
  }
  const f = fixture(); f.set({ ok: true, document: { media: 'image', observation: observed } }); assert.equal((await f.host.read(f.sender, f.source)).code, 'RESOURCE_EDIT_UNSUPPORTED_TEXT');
  assert.equal((await f.host.read(f.sender, { ...f.source, identity: { ...f.source.identity, generation: 2 } })).ok, false);
});
test('native lease retirement while the original reader is pending does not return a late editing source', async () => {
  const f = fixture(); let finish; f.set(new Promise(resolve => { finish = resolve; }));
  const pending = f.host.read(f.sender, f.source); f.expire(); finish({ ok: true, document: { media: 'text', content: 'raw', observation: observed, resolvedPath: '/repo/docs/a.md' } });
  assert.equal((await pending).code, 'RESOURCE_EDIT_SOURCE_CHANGED');
});
test('submission proof retains the real lease and exact chosen descendant while reading its current identity/version', async () => {
  const f = fixture(), target = { reference: { workspaceId: 'bot', path: f.source.path }, base: observed };
  const found = await f.host.resolveSubmissionTarget(f.sender, f.source, target);
  assert.equal(found.ok, true); assert.equal(found.root, '/repo'); assert.equal(found.path, f.source.path); assert.equal(found.validate(), true);
  assert.deepEqual(f.calls[0].request.expectedObservation, { resourceId: observed.resourceId }); assert.equal(f.calls[0].request.loadCurrent, true);
  assert.equal((await f.host.resolveSubmissionTarget(f.sender, f.source, { ...target, reference: { ...target.reference, path: '/repo/docs/b.md' } })).ok, false);
  f.expire(); assert.equal(found.validate(), false);
});
