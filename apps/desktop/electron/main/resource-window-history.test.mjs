import assert from 'node:assert/strict';
import test from 'node:test';
import { createResourceWindowHistory, resourceWindowSourceBinding } from './resource-window-history.mjs';

const owner = { workspaceId: 'bot', conversationId: 'conversation' };
const scope = { owner, root: '/repo', target: '/repo/a.md' };
const context = { viewId: 'never-persist', windowId: 'never-persist', generation: 3, owner, resource: { kind: 'document', reference: { workspaceId: 'bot', path: '/repo/a.md', kind: 'file' }, mode: 'preview' }, navigation: { top: 220, left: 0 }, phase: 'ready' };
test('history stores only normalized reading metadata and survives a fresh module instance', () => {
  let saved;
  const storage = { read: () => saved, write: value => { saved = value; }, createId: () => 'recovery', now: () => '2026-10-26T01:00:00.000Z' };
  const history = createResourceWindowHistory(storage);
  assert.equal(history.save(context, scope), 'recovery');
  assert.equal(JSON.stringify(saved).includes('never-persist'), false);
  const fresh = createResourceWindowHistory(storage), entries = fresh.list(owner).entries;
  assert.equal(entries[0].request.navigation.top, 220); assert.equal(entries[0].sourceBinding, undefined);
  assert.equal(fresh.find('recovery', owner).sourceBinding, resourceWindowSourceBinding(scope));
  assert.equal(fresh.find('recovery', { ...owner, conversationId: 'other' }), null);
  assert.equal(fresh.list({ ...owner, workspaceId: 'other' }).entries.length, 0);
});
test('future/corrupt history and failed storage cannot overwrite existing data or report saved', () => {
  for (const saved of [{ version: 2, entries: [], opaqueFuture: true }, { version: 1, entries: [{ body: 'not a reference' }] }]) {
    let writes = 0;
    const history = createResourceWindowHistory({ read: () => saved, write: () => { writes++; } });
    assert.equal(history.list(owner).status, 'storage_unavailable'); assert.equal(history.save(context, scope), null); assert.equal(writes, 0);
  }
  const broken = createResourceWindowHistory({ write: () => { throw Error('disk_full'); } });
  assert.equal(broken.save(context, scope), null);
});
test('retention is bounded per Bot and globally without replacing unrelated owners', () => {
  let saved, sequence = 0;
  const history = createResourceWindowHistory({ read: () => saved, write: value => { saved = value; }, createId: () => `reading-${++sequence}` });
  for (const workspaceId of ['a', 'b', 'c', 'd']) for (let i = 0; i < 10; i++) {
    const current = { ...owner, workspaceId };
    history.save({ ...context, owner: current, resource: { ...context.resource, reference: { ...context.resource.reference, workspaceId } } }, { ...scope, owner: current });
  }
  assert.equal(saved.entries.length, 24); assert.equal(history.list({ ...owner, workspaceId: 'd' }).entries.length, 8);
  assert.equal(history.remove('reading-40', { ...owner, workspaceId: 'b' }), false);
  assert.equal(history.remove('reading-40', { ...owner, workspaceId: 'd' }), true);
});
test('oversized presentation hints fail without writing a partial record', () => {
  let writes = 0;
  const history = createResourceWindowHistory({ write: () => { writes++; } });
  const resource = { kind: 'comparison', reference: { workspaceId: 'bot', path: '/repo', kind: 'directory' }, fromRef: 'a'.repeat(40) };
  assert.equal(history.save({ ...context, resource, navigation: { top: 1, left: 0, positions: [0, 1, 2].map(i => ({ key: `${i}${'x'.repeat(8000)}`, top: 1, left: 0 })) } }, { ...scope, target: '/repo' }), null);
  assert.equal(writes, 0);
});
