import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateDocumentTab,
  closeDocumentTab,
  createDocumentSessionState,
  createDocumentTabSession,
  normalizeDocumentSessionMap,
  normalizeDocumentSessionState,
  openDocumentTab,
  updateDocumentTabMode,
  updateDocumentReading,
  updateComparisonReading,
} from './documentSessionState.ts';

test('normalizes independent document sessions for each conversation', () => {
  const sessions = normalizeDocumentSessionMap({
    'conversation-a': {
      activeTabId: 'a-2',
      tabs: [
        { id: 'a-1', absPath: '/repo/a.md', mode: 'preview' },
        { id: 'a-2', absPath: '/repo/b.ts', mode: 'source' },
      ],
    },
    'conversation-b': {
      activeTabId: 'b-1',
      tabs: [{ id: 'b-1', absPath: '/other/readme.md', mode: 'diff' }],
    },
  });

  assert.equal(sessions['conversation-a'].tabs.length, 2);
  assert.equal(sessions['conversation-a'].activeTabId, 'a-2');
  assert.equal(sessions['conversation-b'].tabs[0].absPath, '/other/readme.md');
});

test('opens, activates, updates, and closes document tabs', () => {
  const first = createDocumentTabSession('/repo/a.md', { id: 'tab-1', mode: 'preview' });
  const second = createDocumentTabSession('/repo/b.ts', { id: 'tab-2', mode: 'source' });
  let session = createDocumentSessionState();

  session = openDocumentTab(session, first);
  session = openDocumentTab(session, second);
  assert.equal(session.activeTabId, 'tab-2');
  assert.deepEqual(session.tabs.map((tab) => tab.id), ['tab-1', 'tab-2']);

  session = activateDocumentTab(session, 'tab-1');
  session = updateDocumentTabMode(session, 'tab-1', 'diff');
  assert.equal(session.tabs[0].mode, 'diff');

  session = closeDocumentTab(session, 'tab-1');
  assert.equal(session.activeTabId, 'tab-2');
});

test('reopening the same path activates one tab and preserves its mode by default', () => {
  const first = createDocumentTabSession('/repo/a.md', { id: 'tab-1', mode: 'source' });
  let session = openDocumentTab(createDocumentSessionState(), first);
  const duplicate = createDocumentTabSession('/repo/a.md', { id: 'tab-2', mode: 'preview' });

  session = openDocumentTab(session, duplicate);
  assert.equal(session.tabs.length, 1);
  assert.equal(session.activeTabId, 'tab-1');
  assert.equal(session.tabs[0].mode, 'source');

  session = openDocumentTab(session, duplicate, { replaceMode: true });
  assert.equal(session.tabs[0].mode, 'preview');
});

test('closing the final document leaves an empty session', () => {
  const only = createDocumentTabSession('/repo/a.md', { id: 'only' });
  const session = openDocumentTab(createDocumentSessionState(), only);
  const next = closeDocumentTab(session, 'only');

  assert.deepEqual(next, { tabs: [], activeTabId: null });
});

test('invalid and duplicate persisted tabs are discarded', () => {
  const sessions = normalizeDocumentSessionMap({
    conversation: {
      activeTabId: 'missing',
      tabs: [
        { id: 'first', absPath: '/repo/a.md', mode: 'invalid' },
        { id: 'duplicate-path', absPath: '/repo/a.md', mode: 'source' },
        { id: 'first', absPath: '/repo/b.md', mode: 'preview' },
        { id: 'missing-path' },
      ],
    },
  });

  assert.equal(sessions.conversation.tabs.length, 1);
  assert.equal(sessions.conversation.tabs[0].mode, 'preview');
  assert.equal(sessions.conversation.activeTabId, 'first');
});

test('task provenance survives tab restoration and separates task scopes without degrading malformed hints', () => {
  const first = createDocumentTabSession('/internal/result.md', { id: 'task-a', reference: {
    workspaceId: 'bot', path: '/internal/result.md', task: { sessionId: 'a', planId: 'plan-a' } } });
  const second = createDocumentTabSession('/internal/result.md', { id: 'task-b', reference: {
    workspaceId: 'bot', path: '/internal/result.md', task: { sessionId: 'b', planId: 'plan-b' } } });
  const opened = openDocumentTab(openDocumentTab(createDocumentSessionState(), first), second);
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(opened)));
  assert.equal(restored.tabs.length, 2);
  assert.deepEqual(restored.tabs[0].reference?.task, first.reference?.task);
  assert.equal(normalizeDocumentSessionState({ tabs: [{ ...first, reference: { ...first.reference, task: {} } }] }).tabs.length, 0);
  assert.equal(normalizeDocumentSessionState({ tabs: [{ ...first, reference: { ...first.reference, workspaceId: null } }] }).tabs.length, 0);
});

test('observation and bounded reading positions restore without saving body or claiming a snapshot', () => {
  const observation = { sourceId: `sha256:${'a'.repeat(64)}`, resourceId: `sha256:${'b'.repeat(64)}`, contentVersion: `sha256:${'c'.repeat(64)}`, relativePath: 'guide.md' };
  let session = openDocumentTab(createDocumentSessionState(), createDocumentTabSession('/real/guide.md', { id: 'observed' }));
  session = updateDocumentReading(session, 'observed', { observation, position: { key: `${observation.contentVersion}:source`, point: { top: 320, left: 18 } } });
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(session)));
  assert.deepEqual(restored.tabs[0].observation, observation);
  assert.deepEqual(restored.tabs[0].readingPositions?.[`${observation.contentVersion}:source`], { top: 320, left: 18 });
  assert.equal(updateDocumentReading(restored, 'closed-tab', { observation }), restored);
  const damaged = normalizeDocumentSessionState({ tabs: [{ id: 'old', absPath: '/real/guide.md', content: 'must not persist',
    observation: { ...observation, contentVersion: 'mtime:5' }, readingPositions: { bad: { top: 500, left: 0 }, [`${observation.contentVersion}:source`]: { top: -1, left: 0 } } }] });
  assert.equal(damaged.tabs[0].observation, undefined);
  assert.deepEqual(damaged.tabs[0].readingPositions, {});
  assert.equal('content' in damaged.tabs[0], false);
});

test('live files and distinct immutable commits coexist; invalid historical restoration never falls back to live', () => {
  const reference = { workspaceId: 'bot', path: '/repo/doc.md' };
  let session = openDocumentTab(createDocumentSessionState(), createDocumentTabSession(reference.path, { id: 'live', reference }));
  for (const [id, commit] of [['old', 'a'.repeat(40)], ['other', 'b'.repeat(40)]]) {
    session = openDocumentTab(session, createDocumentTabSession(reference.path, { id, reference: { ...reference, revision: { kind: 'git', commit } } }));
  }
  assert.equal(session.tabs.length, 3);
  const contentKey = `sha256:${'c'.repeat(64)}:source`;
  session = updateDocumentReading(session, 'old', { position: { key: contentKey, point: { top: 320, left: 0 } } });
  session = updateDocumentReading(session, 'other', { position: { key: contentKey, point: { top: 650, left: 0 } } });
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(session)));
  assert.equal(restored.tabs.length, 3); assert.equal(restored.tabs[1].reference?.revision?.commit, 'a'.repeat(40));
  assert.equal(restored.tabs[1].readingPositions?.[contentKey].top, 320); assert.equal(restored.tabs[2].readingPositions?.[contentKey].top, 650);
  assert.equal(updateDocumentTabMode(restored, 'old', 'diff'), restored);
  const broken = normalizeDocumentSessionState({ tabs: [{ ...restored.tabs[1], reference: { ...reference, revision: { kind: 'git', commit: 'main' } } }] });
  assert.equal(broken.tabs.length, 0);
});

test('comparison reading metadata restores separately from plain document bytes and invalid hints do not downgrade the target', () => {
  const tab = createDocumentTabSession('/repo', { id: 'comparison', reference: { workspaceId: 'bot', path: '/repo', kind: 'directory' }, comparison: { fromRef: 'a'.repeat(40), toRef: 'b'.repeat(40) }, mode: 'diff' });
  const session = updateComparisonReading({ tabs: [tab], activeTabId: tab.id }, tab.id, { selected: 'src/a.ts', top: 80, left: 0 });
  const restored = normalizeDocumentSessionState(JSON.parse(JSON.stringify(session)));
  assert.equal(restored.tabs[0].resourceReading?.selected, 'src/a.ts'); assert.equal(restored.tabs[0].comparison?.fromRef, 'a'.repeat(40));
  const invalid = normalizeDocumentSessionState({ tabs: [{ ...tab, resourceReading: { top: Infinity, left: 0 } }], activeTabId: tab.id });
  assert.equal(invalid.tabs.length, 0);
});

test('draft locators stay distinct from current files and persist metadata without bodies or writer handles', () => {
  const reference = { workspaceId: 'bot', path: '/repo/a.md' };
  let session = openDocumentTab(createDocumentSessionState(), createDocumentTabSession(reference.path, { id: 'file', reference }));
  session = openDocumentTab(session, createDocumentTabSession(reference.path, { id: 'draft', reference, draftId: 'local-draft' }));
  session = openDocumentTab(session, createDocumentTabSession(reference.path, { id: 'other-base', reference, draftId: 'other-draft' }));
  assert.equal(session.tabs.length, 3); assert.equal(session.activeTabId, 'other-base');
  const restored = normalizeDocumentSessionState({ ...session, tabs: session.tabs.map(tab => ({ ...tab, text: 'secret input', writer: { token: 'secret' } })) });
  assert.equal(restored.tabs.length, 3); assert.equal(JSON.stringify(restored).includes('secret'), false);
  assert.equal(updateDocumentTabMode(restored, 'draft', 'diff'), restored);
});
test('invalid draft metadata is rejected rather than downgraded into an ordinary current-file tab', () => {
  const tab = createDocumentTabSession('/repo/a.md', { reference: { workspaceId: 'bot', path: '/repo/a.md' }, draftId: 'draft' });
  for (const patch of [{ draftId: '../bad' }, { mode: 'diff' }, { comparison: { fromRef: 'HEAD', comparison: 'working' } }, { reference: { workspaceId: 'bot', path: 'a.md' } },
    { reference: { workspaceId: 'bot', path: '/repo/a.md', revision: { ref: 'HEAD' } } }, { reference: { workspaceId: 'bot', path: '/repo/a.md', kind: 'directory' } }]) {
    assert.equal(normalizeDocumentSessionState({ tabs: [{ ...tab, ...patch }], activeTabId: tab.id }).tabs.length, 0);
  }
});
