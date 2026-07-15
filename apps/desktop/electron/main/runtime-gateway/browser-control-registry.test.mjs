import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getActiveBrowserEntry,
  getActiveWebContentsId,
  registerBrowserWebContents,
  resetBrowserControlRegistryForTests,
  unregisterBrowserWebContents,
} from './browser-control-registry.mjs';

test.beforeEach(() => resetBrowserControlRegistryForTests());

test('resolves the active browser tab independently for each conversation', () => {
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
    url: 'https://example.com/a',
  });
  registerBrowserWebContents({
    webContentsId: 21,
    conversationId: 'conversation-b',
    browserTabId: 'b-1',
    active: true,
    url: 'https://example.com/b',
  });

  assert.equal(getActiveWebContentsId('conversation-a'), 11);
  assert.equal(getActiveWebContentsId('conversation-b'), 21);
  assert.equal(getActiveWebContentsId(), 21);
});

test('switching active tabs updates both conversation and foreground targets', () => {
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
  });
  registerBrowserWebContents({
    webContentsId: 12,
    conversationId: 'conversation-a',
    browserTabId: 'a-2',
    active: false,
  });
  registerBrowserWebContents({
    webContentsId: 12,
    conversationId: 'conversation-a',
    browserTabId: 'a-2',
    active: true,
  });

  assert.equal(getActiveBrowserEntry('conversation-a').browserTabId, 'a-2');
  assert.equal(getActiveWebContentsId(), 12);
});

test('never falls back from a missing conversation to another conversation', () => {
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
  });

  assert.equal(getActiveBrowserEntry('conversation-b'), null);
  assert.equal(getActiveWebContentsId('conversation-b'), null);
});

test('unregister only clears the matching conversation tab entry', () => {
  registerBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
    active: true,
  });
  registerBrowserWebContents({
    webContentsId: 21,
    conversationId: 'conversation-b',
    browserTabId: 'b-1',
    active: true,
  });

  assert.deepEqual(unregisterBrowserWebContents({
    webContentsId: 11,
    conversationId: 'conversation-a',
    browserTabId: 'a-1',
  }), { ok: true, cleared: true });
  assert.equal(getActiveBrowserEntry('conversation-a'), null);
  assert.equal(getActiveWebContentsId('conversation-b'), 21);
});

test('rejects registrations without a browser tab identity', () => {
  assert.deepEqual(registerBrowserWebContents({ webContentsId: 1 }), {
    ok: false,
    error: 'invalid_browser_tab_id',
  });
});
