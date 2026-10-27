import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceWindowReader } from './resource-window-reader.mjs';

const id = 'sha256:' + 'a'.repeat(64), version = 'sha256:' + 'b'.repeat(64);
const document = { kind: 'document', reference: { workspaceId: 'bot', path: '/repo/a.md', kind: 'file', task: { sessionId: 'session', planId: 'plan' } }, mode: 'preview' };
function fixture() {
  const calls = [];
  let owner = 'conversation', root = '/repo', redirect;
  const reader = createResourceWindowReader({
    getOwner: async () => owner ? { conversationId: owner } : null,
    resolveDocument: async ref => ({ ok: true, root, target: redirect ?? ref.path }),
    fileAccess: {
      readFile: async ({ documentReference: ref }) => { calls.push(['file', ref]); return { ok: true, status: 'ok', content: ref.metadataOnly ? '' : 'body', metadataOnly: !!ref.metadataOnly,
        resolvedPath: ref.path, resolvedFrom: root, identity: { resourceId: id }, observation: { sourceId: id, resourceId: id, contentVersion: version, relativePath: 'a.md' } }; },
      readDirectory: async ({ documentReference: ref }) => { calls.push(['directory', ref]); return { ok: true, entries: [], resolvedPath: ref.path, resolvedFrom: root }; },
      getGitDiff: async input => { calls.push(['diff', input]); return { ok: true, diffText: 'diff', resolvedPath: input.documentReference.path }; },
      getGitRangeDiff: async input => { calls.push(['range', input]); return { ok: true, diffText: 'diff', resolvedPath: input.documentReference.path, fromRef: input.fromRef, toRef: input.toRef }; },
    },
  });
  return { reader, calls, owner: value => { owner = value; }, root: value => { root = value; }, redirect: value => { redirect = value; } };
}
test('reads inject the captured Bot/task and recheck the physical root and live owner', async () => {
  const f = fixture(), scope = await f.reader.prepare(document);
  assert.equal((await f.reader.read(scope, { operation: 'content' })).document.content, 'body');
  assert.deepEqual(f.calls.at(-1)[1].task, document.reference.task);
  const count = f.calls.length;
  assert.equal((await f.reader.read(scope, { operation: 'content', owner: 'other' })).status, 'invalid_request');
  assert.equal((await f.reader.read(scope, { operation: 'content', path: '/repo/other.md' })).status, 'scope_denied');
  assert.equal(f.calls.length, count);
  f.root('/new-root'); assert.equal((await f.reader.read(scope, { operation: 'content' })).status, 'source_changed');
  f.root('/repo'); f.owner('new-conversation'); assert.equal((await f.reader.read(scope, { operation: 'content' })).status, 'source_unavailable');
});
test('directory descendants remain inside both the captured directory and original scoped resolver', async () => {
  const f = fixture(), resource = { kind: 'directory', reference: { ...document.reference, path: '/repo/docs', kind: 'directory' } };
  const scope = await f.reader.prepare(resource);
  assert.equal((await f.reader.read(scope, { operation: 'directory', path: '/repo/docs/chapter' })).ok, true);
  assert.equal((await f.reader.read(scope, { operation: 'content', path: '/repo/docs/chapter/a.md' })).ok, true);
  assert.equal((await f.reader.read(scope, { operation: 'directory', path: '/repo/docs-other' })).status, 'scope_denied');
  f.redirect('/repo/sibling');
  assert.equal((await f.reader.read(scope, { operation: 'directory', path: '/repo/docs/link' })).status, 'scope_denied');
  assert.equal((await f.reader.read(scope, { operation: 'diff' })).status, 'scope_denied');
});
test('explicit version adoption can remove only the content condition, never file identity or history', async () => {
  const f = fixture(), resource = { ...document, reference: { ...document.reference, expectedObservation: { resourceId: id, contentVersion: version } } };
  const scope = await f.reader.prepare(resource);
  await f.reader.read(scope, { operation: 'content' }); assert.deepEqual(f.calls.at(-1)[1].expectedObservation, resource.reference.expectedObservation);
  await f.reader.read(scope, { operation: 'content', loadCurrent: true }); assert.deepEqual(f.calls.at(-1)[1].expectedObservation, { resourceId: id });
  assert.equal((await f.reader.read(scope, { operation: 'content', expectedObservation: { resourceId: 'sha256:' + 'c'.repeat(64) } })).status, 'source_changed');
  assert.equal((await f.reader.read(scope, { operation: 'content', expectedObservation: { resourceId: id, sourceId: id } })).status, 'invalid_request');
});
test('comparison endpoints are explicit and cannot become a freshly resolved moving branch', async () => {
  const f = fixture(), base = { kind: 'comparison', reference: { ...document.reference, path: '/repo', kind: 'directory' }, fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) };
  assert.equal((await f.reader.prepare({ ...base, fromRef: 'main' })).status, 'invalid_ref');
  const scope = await f.reader.prepare(base);
  assert.equal((await f.reader.read(scope, { operation: 'diff' })).ok, true);
  assert.equal(f.calls.at(-1)[1].fromRef, base.fromRef); assert.equal(f.calls.at(-1)[1].toRef, base.toRef);
  assert.equal((await f.reader.read(scope, { operation: 'content' })).status, 'scope_denied');
});
