import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateBrowserTab,
  addBrowserTab,
  browserSessionKey,
  closeBrowserTab,
  createBrowserSessionState,
  createBrowserTabSession,
  normalizeBrowserSessionMap,
  updateBrowserTab,
} from './browserSessionState.ts';

test('normalizes independent browser sessions for each conversation', () => {
  const sessions = normalizeBrowserSessionMap({
    'conversation-a': {
      activeTabId: 'a-2',
      tabs: [
        { id: 'a-1', url: 'https://example.com/a', title: 'A' },
        { id: 'a-2', url: 'https://example.com/a/2', title: 'A2' },
      ],
    },
    'conversation-b': {
      activeTabId: 'b-1',
      tabs: [{ id: 'b-1', url: 'https://example.com/b', title: 'B' }],
    },
  });

  assert.equal(sessions['conversation-a'].tabs.length, 2);
  assert.equal(sessions['conversation-a'].activeTabId, 'a-2');
  assert.equal(sessions['conversation-b'].tabs[0].url, 'https://example.com/b');
  assert.equal(browserSessionKey(null), '__none');
});

test('adds, activates, updates, and closes tabs without affecting siblings', () => {
  const first = createBrowserTabSession('tab-1', 'https://example.com/one', 'One');
  const second = createBrowserTabSession('tab-2', 'https://example.com/two', 'Two');
  let session = createBrowserSessionState(first);

  session = addBrowserTab(session, second);
  assert.equal(session.activeTabId, 'tab-2');
  assert.equal(session.tabs.length, 2);

  session = updateBrowserTab(session, 'tab-1', { title: 'Updated' });
  assert.equal(session.tabs[0].title, 'Updated');
  assert.equal(session.tabs[1].title, 'Two');

  session = activateBrowserTab(session, 'tab-1');
  session = closeBrowserTab(session, 'tab-1', createBrowserTabSession('unused'));
  assert.equal(session.activeTabId, 'tab-2');
  assert.deepEqual(session.tabs.map((tab) => tab.id), ['tab-2']);
});

test('closing the final tab replaces it with a blank tab', () => {
  const session = createBrowserSessionState(createBrowserTabSession('only', 'https://example.com'));
  const next = closeBrowserTab(session, 'only', createBrowserTabSession('replacement'));

  assert.equal(next.activeTabId, 'replacement');
  assert.deepEqual(next.tabs, [{ id: 'replacement', url: 'about:blank', title: '' }]);
});

test('invalid persisted sessions recover to one usable blank tab', () => {
  const sessions = normalizeBrowserSessionMap({ broken: { activeTabId: 'missing', tabs: [] } });
  assert.equal(sessions.broken.tabs.length, 1);
  assert.equal(sessions.broken.tabs[0].url, 'about:blank');
  assert.equal(sessions.broken.activeTabId, sessions.broken.tabs[0].id);
});
