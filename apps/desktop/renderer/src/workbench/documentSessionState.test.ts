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
