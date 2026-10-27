import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { bindBrowserSelectionFeedback } from './browser-selection-feedback.mjs';
function fixture() {
  const contents = new EventEmitter(), sourceSender = {}, menus = [], preparations = [], notices = []; let sequence = 0, url = 'https://example.com/page', result = { ok: true };
  const frame = { processId: 1, routingId: 2, frameToken: 'frame', detached: false, url };
  contents.id = 42; contents.getURL = () => url; contents.isDestroyed = () => false;
  let binding = { sourceSender, recipient: { workspaceId: 'bot', conversationId: 'main' }, conversationId: 'task', browserTabId: 'tab' };
  const stop = bindBrowserSelectionFeedback({ contents, getBinding: () => binding, prepare: async request => { preparations.push(request); return result; },
    popup: menu => menus.push(menu), report: notice => notices.push(notice), createId: () => `id-${++sequence}` });
  const select = (selectionText = 'human selected', target = frame) => {
    const params = { selectionText, frame: target, frameURL: target?.url, pageURL: url }; contents.emit('context-menu', { preventDefault() {} }, params); return menus.at(-1);
  };
  return { contents, frame, menus, preparations, notices, select, stop, fail: () => { result = { ok: false, code: 'DRAFT_PREPARATION_UNCONFIRMED' }; },
    navigate: (target = frame, isMainFrame = true) => contents.emit('did-start-navigation', { isMainFrame, frame: target }),
    changeOwner: () => { binding = { ...binding, recipient: { workspaceId: 'other', conversationId: 'other-main' } }; } };
}
test('selection is inert until explicit context-menu action; frame source and parent page are separate', async () => {
  const h = fixture(); assert.equal(h.preparations.length, 0); h.frame.url = 'https://frames.example/doc';
  const menu = h.select(); assert.equal(menu.enabled, true); assert.equal(h.preparations.length, 0); await menu.onClick();
  const request = h.preparations[0]; assert.equal(request.feedback.resource.url, h.frame.url);
  assert.equal(request.feedback.resource.pageUrl, 'https://example.com/page'); assert.equal(request.feedback.resource.conversationId, 'task');
  assert.equal(request.feedback.recipient.conversationId, 'main'); assert.equal(request.feedback.selection.kind, 'discussion');
  assert.equal(h.notices.at(-1).phase, 'prepared'); assert.equal(await request.isCurrent(), true); h.stop();
});
test('stale menus cannot follow same-URL navigation, changed iframe generation or replaced owner', async () => {
  for (const mutate of [h => h.navigate(), h => h.navigate(h.frame, false), h => h.changeOwner(), h => { h.frame.detached = true; }]) {
    const h = fixture(), menu = h.select(); mutate(h); await menu.onClick();
    assert.equal(h.preparations.length, 0); assert.equal(h.notices.at(-1).code, 'SOURCE_CHANGED'); h.stop();
  }
});
test('oversize, unsupported or inaccessible frame selections do not prepare; no automatic page script is available', async () => {
  const h = fixture(); assert.equal(h.select('x'.repeat(8193)).enabled, false); await h.menus.at(-1).onClick();
  h.frame.url = 'file:///private'; assert.equal(h.select().enabled, false);
  assert.equal(h.preparations.length, 0); assert.equal('executeJavaScript' in h.contents, false);
  h.stop(); assert.equal(h.contents.listenerCount('context-menu'), 0); assert.equal(h.contents.listenerCount('did-start-navigation'), 0);
});
test('unconfirmed preparation retries same selection ID; navigating retires it and cleanup prevents further work', async () => {
  const h = fixture(); h.fail(); await h.select().onClick(); assert.equal(h.notices.at(-1).phase, 'unconfirmed');
  await h.select().onClick(); assert.equal(h.preparations[1].feedback.id, h.preparations[0].feedback.id);
  h.navigate(); await h.select().onClick(); assert.notEqual(h.preparations[2].feedback.id, h.preparations[0].feedback.id);
  h.contents.emit('destroyed'); h.select(); assert.equal(h.menus.length, 3);
});
