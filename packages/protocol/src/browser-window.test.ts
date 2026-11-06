import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserWindowCopyRequest, normalizeBrowserWindowUrl } from './browser-window.ts';
test('native address copies accept exact instance references, not renderer URL/authority fields', () => {
  const request = { conversationId: 'c', browserTabId: 'b', webContentsId: 41 };
  assert.deepEqual(normalizeBrowserWindowCopyRequest(request), request);
  for (const extra of [{ url: 'https://example.com' }, { permission: true }, { windowId: 'forged' }]) assert.equal(normalizeBrowserWindowCopyRequest({ ...request, ...extra }), null);
  assert.equal(normalizeBrowserWindowCopyRequest({ ...request, webContentsId: -1 }), null);
});
test('native navigation cannot access local/app/data/javascript or credential-bearing URLs', () => {
  for (const url of ['file:///etc/hosts', 'peer://app', 'data:text/html,hi', 'javascript:alert(1)', 'https://user:pass@example.com', 'https://' + 'a'.repeat(8192)]) assert.equal(normalizeBrowserWindowUrl(url), null);
  assert.equal(normalizeBrowserWindowUrl('https://example.com/path#anchor'), 'https://example.com/path#anchor');
});
