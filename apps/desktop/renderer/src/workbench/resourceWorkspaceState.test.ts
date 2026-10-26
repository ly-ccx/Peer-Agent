import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileResourceOrder, resourceNeighbor, normalizeResourcePreferences, resourceWebUrl, resourceLayoutBounds } from './resourceWorkspaceState.ts';
import { createDocumentSessionState, createDocumentTabSession, openDocumentTab, normalizeDocumentComparison, normalizeDocumentSessionState } from './documentSessionState.ts';

test('resource layout preserves two usable surfaces by collapsing navigation before using a single area', () => {
  const bounds = (width: number) => resourceLayoutBounds(width, 292, 10, 480, 320);
  assert.deepEqual(bounds(1316), { navigationCollapsed: false, primaryMin: 792, compact: false, sideMax: 514 });
  assert.deepEqual(bounds(1000), { navigationCollapsed: true, primaryMin: 500, compact: false, sideMax: 490 });
  assert.equal(bounds(830).compact, false);
  assert.equal(bounds(829).compact, true);
  assert.equal(bounds(1600).navigationCollapsed, false);
  assert.equal(bounds(0).sideMax, 320);
});

test('R4d mixed order retains identity and closes to a real adjacent resource', () => {
  const order = reconcileResourceOrder(['document:a', 'browser:b', 'document:c'], ['document:a', 'document:c', 'browser:b', 'comparison:workspace']);
  assert.deepEqual(order, ['document:a', 'browser:b', 'document:c', 'comparison:workspace']);
  assert.equal(resourceNeighbor(order, 'browser:b'), 'document:c');
  assert.equal(resourceNeighbor(['document:a'], 'document:a'), 'launcher');
  assert.deepEqual(reconcileResourceOrder(order, ['document:c']), ['document:c']);
});

test('R4d corrupt preferences are bounded presentation metadata', () => {
  assert.deepEqual(normalizeResourcePreferences({ order: ['a', 'a', null, {}, 'x'.repeat(8192)], recent: 'bad' }), { order: ['a'], recent: [] });
  assert.equal(normalizeResourcePreferences({ recent: Array.from({ length: 40 }, (_, i) => `${i}`) }).recent.length, 16);
});

test('R4c launcher accepts explicit web addresses without executing search or commands', () => {
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com', 'git status', 'example.com']) assert.equal(resourceWebUrl(value), null);
  assert.equal(resourceWebUrl('https://example.com/a?q=b'), 'https://example.com/a?q=b');
});

test('R1/R4d same relative filename in different sources survives persistence', () => {
  let state = createDocumentSessionState();
  for (const [id, relativeTo] of [['a', '/repo-a/docs/index.md'], ['b', '/repo-b/docs/index.md']]) state = openDocumentTab(state,
    createDocumentTabSession('guide.md', { id, reference: { workspaceId: 'bot', path: 'guide.md', relativeTo } }));
  assert.equal(state.tabs.length, 2);
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.tabs.length, 2);
  assert.equal(restored.activeTabId, 'b');
});

test('reopening a file targets its new line without creating a duplicate tab or changing its authority', () => {
  const reference = { workspaceId: 'bot', path: '/repo/a.ts' };
  let state = normalizeDocumentSessionState(openDocumentTab(createDocumentSessionState(), createDocumentTabSession(reference.path, { id: 'first', reference, mode: 'source', line: 8 })));
  state = normalizeDocumentSessionState(openDocumentTab(state, createDocumentTabSession(reference.path, { id: 'second', reference, mode: 'source', line: 8 }), { replaceMode: true }));
  assert.equal(state.tabs.length, 1); assert.equal(state.activeTabId, 'first');
  assert.deepEqual(state.tabs[0]?.navigation, { line: 8, requestId: 'second' });
  assert.deepEqual(state.tabs[0]?.reference, reference);
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.tabs[0]?.navigation, { line: 8, requestId: 'second' });
  state = normalizeDocumentSessionState(openDocumentTab(state, createDocumentTabSession(reference.path, { id: 'third', reference, mode: 'source', line: 90 }), { replaceMode: true }));
  assert.deepEqual(state.tabs[0]?.navigation, { line: 90, requestId: 'third' });
  const legacy = normalizeDocumentSessionState({ ...state, tabs: [{ ...state.tabs[0], navigation: { line: 90, requestId: '' } }] });
  assert.deepEqual(legacy.tabs[0]?.navigation, { line: 90, requestId: 'restored:first' });
  assert.equal(createDocumentTabSession('/repo/a.ts', { line: -4 }).navigation, undefined);
});

test('distinct fixed comparisons in the same directory survive mixed tabs and restoration without being deduplicated', () => {
  const reference = { workspaceId: 'bot', path: '/repo', kind: 'directory' as const };
  let state = createDocumentSessionState();
  for (const [id, toRef] of [['a', 'b'.repeat(40)], ['b', 'c'.repeat(40)]]) state = openDocumentTab(state,
    createDocumentTabSession('/repo', { id, reference, mode: 'diff', comparison: { fromRef: 'a'.repeat(40), toRef } }));
  state = openDocumentTab(state, createDocumentTabSession('/repo', { id: 'duplicate', reference, mode: 'diff', comparison: { fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) } }));
  assert.equal(state.tabs.length, 2); assert.equal(state.activeTabId, 'a');
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.tabs.length, 2); assert.equal(restored.tabs[0]?.reference?.kind, 'directory');
  assert.equal(restored.tabs[1]?.comparison?.toRef, 'c'.repeat(40));
  assert.equal(normalizeDocumentComparison({ fromRef: 'main', toRef: 'topic' }), undefined);
  assert.equal(normalizeDocumentComparison({ fromRef: 'a'.repeat(40), toRef: '-command' }), undefined);
  assert.deepEqual(normalizeDocumentComparison({ comparison: 'working', fromRef: '-ignored' }), { comparison: 'working', fromRef: 'HEAD' });
  assert.equal(normalizeDocumentSessionState({ tabs: [{ ...state.tabs[0], comparison: { fromRef: 'main' } }] }).tabs.length, 0);
});
