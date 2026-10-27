import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createBrowserWindowController } from './browser-window-controller.mjs';

function harness(options = {}) {
  let next = 10, ids = 0, disposed = false, current = null, focusAllowed = false;
  const roles = new Map(), windows = [], guests = [], entries = new Map();
  class Contents extends EventEmitter {
    constructor(type = 'window') { super(); this.id = next++; this.type = type; this.url = 'about:blank'; this.dead = false; this.sent = []; this.loads = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; }
    getType() { return this.type; } getURL() { return this.url; } getTitle() { return 'Example'; }
    isDestroyed() { return this.dead; } isLoading() { return false; } getZoomFactor() { return 1; }
    setWindowOpenHandler(fn) { this.popups = fn; }
    async loadURL(url) { this.url = url; this.loads.push(url); }
    send(...args) { this.sent.push(args); }
    close() { if (!this.dead) { this.dead = true; this.emit('destroyed'); } }
    reload() {} stop() {}
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.webContents = new Contents(); this.options = options; this.focuses = 0; this.dead = false;
      this.contentView = { addChildView: view => { this.view = view; } }; windows.push(this); }
    isDestroyed() { return this.dead; } isMinimized() { return false; } isVisible() { return true; } getContentSize() { return [1000, 700]; }
    async loadURL(url) { this.loaded = url; }
    show() {} focus() { this.focuses++; this.emit('focus'); }
    close() { this.destroy(); }
    destroy() { if (!this.dead) { this.dead = true; this.emit('closed'); this.webContents.close(); } }
    static fromWebContents(sender) { return sender === source ? sourceWindow : windows.find(w => w.webContents === sender); }
  }
  class View {
    constructor(options) { this.options = options; this.webContents = new Contents('browserView'); guests.push(this); }
    setVisible(value) { this.visible = value; } setBounds(bounds) { this.bounds = bounds; }
  }
  const source = new Contents(), sourceWindow = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
  const embedded = new Contents('webview'); embedded.url = 'https://example.com/original'; embedded.hostWebContents = source;
  roles.set(source, 'main'); entries.set('c\0source-tab', { webContentsId: embedded.id, browserTabId: 'source-tab' });
  const controller = createBrowserWindowController({ BrowserWindow: Window, WebContentsView: View, rendererLocation: 'file:///app/index.html', preloadPath: '/app/browser-window.cjs',
    trustedWindows: { getRole: s => roles.get(s), registerWindow: ({ window, role }) => roles.set(window.webContents, role) },
    getWebContents: id => id === embedded.id ? embedded : null, getEntry: (c, tab) => tab ? entries.get(`${c}\0${tab}`) : current?.conversationId === c ? current : null,
    register: item => { entries.set(`${item.conversationId}\0${item.browserTabId}`, item); if (item.active) current = item; return { ok: true }; },
    unregister: item => { entries.delete(`${item.conversationId}\0${item.browserTabId}`); if (current?.webContentsId === item.webContentsId) current = null; },
    getOwner: c => !disposed && c === 'c' ? { conversationId: c, workspaceId: 'bot' } : null,
    canFocus: () => focusAllowed, ...options, createId: () => `id-${++ids}` });
  const request = { conversationId: 'c', browserTabId: 'source-tab', webContentsId: embedded.id };
  const open = () => controller.copy(source, request);
  const present = result => controller.viewport(windows.at(-1).webContents, { identity: result.state.identity, rect: { x: 12, y: 110, width: 970, height: 570 } });
  return { controller, windows, guests, source, embedded, request, open, present, roles,
    setFocusAllowed: value => { focusAllowed = value; }, removeOwner: () => { disposed = true; }, getCurrent: () => current };
}

test('copy requires the real source guest, current conversation and exact tab; never trusts a URL', async t => {
  const h = harness(); t.after(() => h.controller.dispose());
  assert.equal((await h.controller.copy({}, h.request)).status, 'scope_denied');
  assert.equal((await h.controller.copy(h.source, { ...h.request, url: 'https://evil.example' })).status, 'scope_denied');
  assert.equal((await h.controller.copy(h.source, { ...h.request, browserTabId: 'other' })).status, 'scope_denied');
  h.embedded.url = 'file:///private/secret'; assert.equal((await h.open()).ok, false);
  assert.equal(h.windows.length, 0);
});

test('fresh instance owns minimal chrome and isolated remote contents; closing destroys only its own guest', async t => {
  const h = harness(); t.after(() => h.controller.dispose());
  const a = await h.open(); const b = await h.open();
  assert.equal(a.ok, true); assert.equal(b.ok, true); assert.notEqual(a.state.browserTabId, 'source-tab');
  assert.notEqual(a.state.browserTabId, b.state.browserTabId);
  assert.equal(h.windows[0].options.webPreferences.webviewTag, false);
  assert.equal(h.guests[0].options.webPreferences.preload, undefined);
  assert.equal(h.guests[0].options.webPreferences.nodeIntegration, false);
  assert.deepEqual(h.guests[0].webContents.loads, ['https://example.com/original']);
  assert.equal(h.guests[0].webContents.popups({ url: 'https://example.org' }).action, 'deny');
  h.windows[0].close(); assert.equal(h.guests[0].webContents.isDestroyed(), true);
  assert.equal(h.guests[1].webContents.isDestroyed(), false); assert.equal(h.embedded.isDestroyed(), false);
});

test('wrong sender/generation and non-http navigation fail; remote navigations are guarded', async t => {
  const h = harness(); t.after(() => h.controller.dispose()); const r = await h.open();
  assert.equal((await h.controller.action(h.source, { identity: r.state.identity, action: 'reload' })).status, 'stale_view');
  assert.equal((await h.controller.action(h.windows[0].webContents, { identity: { ...r.state.identity, generation: 'old' }, action: 'reload' })).status, 'stale_view');
  assert.equal((await h.controller.action(h.windows[0].webContents, { identity: r.state.identity, action: 'navigate', url: 'javascript:alert(1)' })).status, 'invalid_request');
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    let prevented = false;
    h.guests[0].webContents.emit(event, { url: 'file:///private/secret', preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test('viewport is clipped to content; native reveal never calls main ack or steals background attention', async t => {
  const h = harness(); t.after(() => h.controller.dispose()); const r = await h.open();
  assert.throws(() => h.controller.reveal({ conversationId: 'c' }), /unavailable/);
  h.present(r); const before = h.windows[0].focuses;
  assert.equal(h.controller.reveal({ conversationId: 'c', focus: true }).focused, false);
  assert.equal(h.windows[0].focuses, before);
  h.setFocusAllowed(true); assert.equal(h.controller.reveal({ conversationId: 'c', focus: true }).focused, true);
  assert.equal(h.controller.reveal({ conversationId: 'other' }), null);
  const resize = h.controller.viewport(h.windows[0].webContents, { identity: r.state.identity, rect: { x: 12, y: 110, width: 5000, height: 5000 } });
  assert.equal(resize.ok, true); assert.deepEqual(h.guests[0].bounds, { x: 12, y: 110, width: 988, height: 590 });
});

test('at most eight native instances; disposed/owner-less sources cannot open', async t => {
  const h = harness(); t.after(() => h.controller.dispose());
  for (let i = 0; i < 8; i++) assert.equal((await h.open()).ok, true);
  assert.equal((await h.open()).status, 'limit_reached');
  h.windows[0].close(); h.removeOwner(); assert.equal((await h.open()).ok, false);
});

test('return is acknowledged only by captured main sender and generation; close leaves original page alone', async t => {
  const h = harness(); t.after(() => h.controller.dispose()); const r = await h.open();
  const result = h.controller.action(h.windows[0].webContents, { identity: r.state.identity, action: 'return' });
  await Promise.resolve();
  const [, message] = h.source.sent.at(-1);
  const ack = { requestId: message.requestId, identity: message.identity, status: 'source_tab_closed' };
  assert.equal(h.controller.acknowledgeReturn({}, ack).ok, false);
  assert.equal(h.controller.acknowledgeReturn(h.source, { ...ack, identity: { ...ack.identity, generation: 'old' } }).ok, false);
  assert.equal(h.controller.acknowledgeReturn(h.source, ack).ok, true);
  assert.equal((await result).returnStatus, 'source_tab_closed');
  assert.equal(h.controller.acknowledgeReturn(h.source, ack).ok, false);
  assert.deepEqual(h.embedded.loads, []);
});


test('native selection prepares a quote through the actual original sender, retaining source task and captured window identity', async t => {
  const menus = [], preparations = [];
  const h = harness({ getFeedbackRecipient: () => ({ workspaceId: 'bot', conversationId: 'primary' }),
    popupFeedback: (win, menu) => menus.push({ win, menu }), prepareFeedback: async request => { preparations.push(request); return { ok: true }; } });
  t.after(() => h.controller.dispose()); const opened = await h.open(), guest = h.guests[0].webContents;
  const frame = { detached: false, processId: 1, routingId: 2, frameToken: 'frame', url: guest.getURL() };
  guest.emit('context-menu', { preventDefault() {} }, { selectionText: 'selected by user', frame });
  assert.equal(preparations.length, 0); await menus[0].menu.onClick();
  assert.equal(menus[0].win, h.windows[0]); assert.equal(preparations[0].sourceSender, h.source);
  assert.deepEqual(preparations[0].identity, opened.state.identity);
  assert.equal(preparations[0].feedback.resource.conversationId, 'c'); assert.equal(preparations[0].feedback.recipient.conversationId, 'primary');
  assert.equal(h.windows[0].webContents.sent.at(-1)[0], 'resource-feedback:notice');
  h.windows[0].close(); assert.equal(guest.listenerCount('context-menu'), 0); assert.equal(h.embedded.isDestroyed(), false);
});
