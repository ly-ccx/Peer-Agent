import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptNativeBrowserState, returnBrowserSource } from './nativeBrowserPresentation.ts';
import { createBrowserSessionState, createBrowserTabSession, addBrowserTab } from './browserSessionState.ts';
import type { BrowserWindowState } from '@peer-agent/protocol';
const state: BrowserWindowState = { identity: { viewId: 'v', windowId: 'w', generation: 'g' }, conversationId: 'c', browserTabId: 'copy',
  url: 'https://example.com/loaded', title: 'Loaded', loading: false, canBack: false, canForward: false, failure: null, copy: true, sequence: 4 };
test('late bootstrap/action state cannot roll back live navigation or rebind a reused view id', () => {
  assert.equal(acceptNativeBrowserState(state, { ...state, sequence: 0, url: 'about:blank' }), state);
  assert.equal(acceptNativeBrowserState(state, { ...state, sequence: 5, identity: { ...state.identity, generation: 'old' } }), state);
  const next = { ...state, sequence: 5, url: 'https://example.com/new' };
  assert.equal(acceptNativeBrowserState(state, next), next);
});
test('return preserves later original-page URL/history metadata; closed source is never recreated', () => {
  const original = createBrowserTabSession('original', 'https://example.com/later');
  const session = addBrowserTab(createBrowserSessionState(original), createBrowserTabSession('other', 'https://example.org'));
  const returned = returnBrowserSource(session, 'original');
  assert.equal(returned.status, 'returned'); assert.equal(returned.session.activeTabId, 'original');
  assert.equal(returned.session.tabs.find(tab => tab.id === 'original')?.url, 'https://example.com/later');
  assert.equal(returned.session.tabs.length, session.tabs.length);
  const closed = returnBrowserSource(session, 'closed');
  assert.equal(closed.status, 'source_tab_closed'); assert.equal(closed.session, session);
});
