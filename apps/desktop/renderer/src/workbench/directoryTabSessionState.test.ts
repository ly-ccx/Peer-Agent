import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activateDirectoryTabState,
  closeDirectoryTabState,
  createDirectoryTabState,
  directoryTabKey,
  normalizeDirectoryTabState,
  normalizeDirectoryTabSessionMap,
  openDirectoryTabState,
  updateDirectoryTabReference,
  type DirectoryTabSession,
} from './directoryTabSessionState.ts';

function tab(id: string, path: string, extra: Partial<DirectoryTabSession['reference']> = {}): DirectoryTabSession {
  return { id, reference: { kind: 'directory', workspaceId: 'ws-a', path, ...extra } };
}

test('opening dedupes by reference identity and activates the existing tab', () => {
  const first = openDirectoryTabState(createDirectoryTabState(), tab('t1', 'kxt/runs'));
  const again = openDirectoryTabState(first, tab('t2', 'kxt/runs'));
  assert.equal(again.tabs.length, 1);
  assert.equal(again.activeTabId, 't1');
  const withTask = openDirectoryTabState(again, tab('t3', 'kxt/runs', { task: { sessionId: 's', planId: 'p' } }));
  assert.equal(withTask.tabs.length, 2, 'a task-scoped directory is a different resource');
  assert.equal(withTask.activeTabId, 't3');
});

test('closing follows the right-neighbor rule and empties into the null state', () => {
  let session = createDirectoryTabState();
  for (const [id, path] of [['a', 'one'], ['b', 'two'], ['c', 'three']] as const) session = openDirectoryTabState(session, tab(id, path));
  session = activateDirectoryTabState(session, 'b');
  const closedMiddle = closeDirectoryTabState(session, 'b');
  assert.equal(closedMiddle.activeTabId, 'c', 'right neighbor first');
  const closedInactive = closeDirectoryTabState(closedMiddle, 'a');
  assert.equal(closedInactive.activeTabId, 'c', 'closing an inactive tab keeps the active one');
  const closedLast = closeDirectoryTabState(closeDirectoryTabState(closedInactive, 'c'), 'c');
  assert.deepEqual(closedLast, createDirectoryTabState());
});

test('tab-internal navigation rewrites only the active tab reference', () => {
  let session = openDirectoryTabState(createDirectoryTabState(), tab('a', 'kxt/runs'));
  session = updateDirectoryTabReference(session, 'a', tab('a', 'kxt/worktrees').reference);
  assert.equal(session.tabs[0]!.reference.path, 'kxt/worktrees');
  const untouched = updateDirectoryTabReference(session, 'missing', tab('x', 'elsewhere').reference);
  assert.equal(untouched, session, 'unknown tab ids leave the session unchanged');
});

test('normalization drops malformed tabs, dedupes identities and rejects hostile map keys', () => {
  const valid = tab('t1', 'kxt/runs', { task: { sessionId: 's', planId: 'p' }, relativeTo: '/vault' });
  const restored = normalizeDirectoryTabState({ tabs: [valid,
    { id: 't1', reference: { kind: 'directory', workspaceId: 'ws-a', path: 'kxt/runs', task: { sessionId: 's', planId: 'p' }, relativeTo: '/vault' } },
    { id: 't2', reference: { kind: 'directory', workspaceId: 'ws-a', path: '', } },
    { id: 't3', reference: { kind: 'file', workspaceId: 'ws-a', path: 'a.md' } },
    { id: 't4', reference: { kind: 'directory', workspaceId: 'ws-a', path: 'kxt', revision: { kind: 'git', commit: 'a'.repeat(40) } } },
    { id: 't5', reference: { kind: 'directory', workspaceId: 'ws-a', path: 'kxt', metadataOnly: true } },
    { id: '', reference: { kind: 'directory', workspaceId: 'ws-a', path: 'kxt' } }], activeTabId: 't1' });
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.activeTabId, 't1');
  assert.deepEqual(normalizeDirectoryTabState({ tabs: [{ id: 'x', reference: null }] }), createDirectoryTabState());
  const map = normalizeDirectoryTabSessionMap({ 'ws-a': { tabs: [valid], activeTabId: 't1' }, __proto__: { tabs: [valid] } });
  assert.deepEqual(Object.keys(map), ['ws-a']);
});

test('directoryTabKey separates relativeTo and task scopes', () => {
  assert.notEqual(directoryTabKey(tab('a', 'kxt', { relativeTo: '/vault' })), directoryTabKey(tab('b', 'kxt')));
  assert.notEqual(directoryTabKey(tab('a', 'kxt', { task: { sessionId: 's', planId: 'p' } })), directoryTabKey(tab('b', 'kxt')));
  assert.equal(directoryTabKey(tab('a', 'kxt')), directoryTabKey(tab('b', 'kxt')));
});
