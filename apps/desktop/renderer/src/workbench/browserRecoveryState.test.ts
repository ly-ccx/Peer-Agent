import assert from 'node:assert/strict';
import test from 'node:test';
import { browserReopensFromUrl, browserRecoveryDescription } from './browserRecoveryState.ts';
import { createBrowserSessionState, createBrowserTabSession, normalizeBrowserSessionMap, normalizeBrowserSessionState, updateBrowserTab } from './browserSessionState.ts';

test('new pages are not mislabeled as recovered; visited or legacy persisted pages are URL-only on guest recreation', () => {
  const tab = createBrowserTabSession('one', 'https://example.com', 'Example');
  assert.equal(browserReopensFromUrl(tab), false);
  const state = updateBrowserTab(createBrowserSessionState(tab), 'one', { url: tab.url });
  assert.equal(browserReopensFromUrl(state.tabs[0]), true);
  assert.equal(browserReopensFromUrl(normalizeBrowserSessionState(state).tabs[0]), true);
  assert.equal(browserReopensFromUrl(normalizeBrowserSessionMap({ A: createBrowserSessionState(tab) }).A.tabs[0]), true);
  assert.equal(browserReopensFromUrl(createBrowserTabSession()), false);
  const blank = updateBrowserTab(state, 'one', { url: 'about:blank' });
  assert.equal(browserReopensFromUrl(blank.tabs[0]), false);
});

test('URL recovery promises no forms, position or history and does not introduce webpage data into sessions', () => {
  assert.match(browserRecoveryDescription(false), /not restored/); assert.match(browserRecoveryDescription(true), /未恢复/);
  const state = normalizeBrowserSessionState({ tabs: [{ id: 'one', url: 'https://example.com', title: 'Ex', visited: true,
    form: 'secret', pageBody: 'private', history: ['sensitive'], webContentsId: 99 }], activeTabId: 'one' });
  assert.deepEqual(Object.keys(state.tabs[0]).sort(), ['id', 'title', 'url', 'visited']);
});
