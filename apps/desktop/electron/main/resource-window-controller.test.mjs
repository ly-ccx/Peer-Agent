import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createResourceWindowController } from './resource-window-controller.mjs';
import { getDesktopIpcPolicy } from '../ipc/channels.mjs';
import { createTrustedWindowRegistry } from './ipc/trusted-window-registry.mjs';

const request = { resource: { kind: 'document', reference: { workspaceId: 'bot', path: '/repo/a.md' }, mode: 'preview' }, sourceTabId: 'tab' };
function fixture(options = {}) {
  const roles = new Map(), children = [], sent = [];
  let rejectLoad = false, hangLoad = false, reads = 0, focused = 0;
  let savedHistory = options.history, currentRoot = '/repo';
  const sender = () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false });
    contents.send = (channel, payload) => {
      sent.push([channel, payload]);
      if (options.acknowledge !== false && channel === 'resource-window:return-target') queueMicrotask(() => host.acknowledgeReturn(contents, { requestId: payload.requestId, identity: payload.context, status: 'returned' }));
      if (options.acknowledge !== false && channel === 'resource-window:checkpoint-request') queueMicrotask(() => host.acknowledgeCheckpoint(contents, { ...payload, status: options.checkpointStatus?.() ?? 'confirmed' }));
    };
    return contents;
  };
  const source = sender(); roles.set(source, 'main');
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = sender(); this.destroyed = false; children.push(this); }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.url = url; if (rejectLoad) throw Error('load_failed'); if (hangLoad) await new Promise(() => {}); }
    show() {} isMinimized() { return false; } restore() {} focus() { focused++; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented && !options.preventUnload?.()) this.destroy(); }
    static fromWebContents(contents) { return contents === source ? { isDestroyed: () => false, show() {}, focus() { focused++; }, isMinimized: () => false } : children.find(child => child.webContents === contents); }
  }
  const host = createResourceWindowController({ BrowserWindow: Window, trustedWindows: { getRole: sender => roles.get(sender), registerWindow: ({ window, role }) => { roles.set(window.webContents, role); window.webContents.once('destroyed', () => roles.delete(window.webContents)); } },
    rendererLocation: 'https://app.local/index.html', preloadPath: '/app/resource-window.cjs',
    readHistory: () => savedHistory, writeHistory: value => { if (options.failStorage) throw Error('disk_full'); savedHistory = value; },
    getOwner: async () => ({ conversationId: 'conversation' }), getAppearance: () => ({ mode: 'dark', secret: 'never returned' }),
    resolveDocument: async ref => ({ ok: true, root: currentRoot, target: ref.path.replace(/^\/repo(?=\/|$)/, currentRoot) }),
    fileAccess: { readFile: async ({ documentReference: ref }) => { reads++; return { ok: true, metadataOnly: !!ref.metadataOnly, content: '', resolvedPath: ref.path, resolvedFrom: currentRoot,
      identity: { resourceId: 'sha256:' + 'a'.repeat(64) }, observation: { sourceId: 'sha256:' + 'b'.repeat(64), resourceId: 'sha256:' + 'a'.repeat(64), contentVersion: 'sha256:' + 'c'.repeat(64), relativePath: 'a.md' } }; } },
  });
  return { host, source, children, sent, roles, rejectLoad: () => { rejectLoad = true; }, hangLoad: () => { hangLoad = true; }, history: () => savedHistory, root: value => { currentRoot = value; }, reads: () => reads, focused: () => focused };
}
test('native view is a separate sandboxed copy, not a task/main-window owner', async () => {
  const f = fixture(), opened = await f.host.open(f.source, request), child = f.children[0];
  assert.equal(opened.ok, true); assert.equal(child.url, 'https://app.local/index.html?window=resource');
  assert.deepEqual(child.options.webPreferences, { preload: '/app/resource-window.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
  assert.equal((await f.host.read(child.webContents, { identity: opened.context, operation: 'content' })).status, 'not_ready');
  assert.equal(f.host.ready(child.webContents, opened.context).ok, true);
  assert.equal((await f.host.read(child.webContents, { identity: opened.context, operation: 'content' })).ok, true);
  assert.equal((await f.host.read(f.source, { identity: opened.context, operation: 'content' })).status, 'scope_denied');
  assert.deepEqual(f.host.appearance(child.webContents), { appearance: { mode: 'dark' }, locale: '' });
  assert.equal((await f.host.returnToSource(child.webContents, opened.context)).ok, true);
  assert.equal(f.sent[0][0], 'resource-window:return-target'); assert.equal(f.focused(), 1);
  f.host.close(child.webContents, opened.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.host.bootstrap(child.webContents).ok, false); assert.equal(f.roles.get(f.source), 'main');
  f.host.dispose();
});
test('failed saving preserves the native view; another close checks saving again', async () => {
  let status = 'blocked'; const f = fixture({ checkpointStatus: () => status });
  try {
    const opened = await f.host.open(f.source, request), child = f.children[0]; f.host.ready(child.webContents, opened.context);
    child.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.isDestroyed(), false);
    assert.equal(f.sent.at(-1)[0], 'resource-window:close-blocked'); assert.equal(f.sent.at(-1)[1].reason, 'save_failed');
    status = 'confirmed'; child.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.isDestroyed(), true);
    assert.equal(f.sent.filter(([channel]) => channel === 'resource-window:checkpoint-request').length, 2);
  } finally { f.host.dispose(); }
});
test('a timed out close stays open and a late acknowledgement cannot close it', { timeout: 2000 }, async () => {
  const f = fixture({ acknowledge: false });
  try {
    const opened = await f.host.open(f.source, request), child = f.children[0]; f.host.ready(child.webContents, opened.context);
    child.close(); const packet = f.sent.find(([channel]) => channel === 'resource-window:checkpoint-request')[1];
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(child.isDestroyed(), false); assert.equal(f.sent.at(-1)[1].reason, 'unconfirmed');
    assert.equal(f.host.acknowledgeCheckpoint(child.webContents, { ...packet, status: 'confirmed' }).ok, false);
    assert.equal(child.isDestroyed(), false);
  } finally { f.host.dispose(); }
});
test('beforeunload veto consumes only this close permit, so a second close requests a fresh checkpoint', async () => {
  let preventUnload = true, status = 'confirmed'; const f = fixture({ preventUnload: () => preventUnload, checkpointStatus: () => status });
  try {
    const opened = await f.host.open(f.source, request), child = f.children[0]; f.host.ready(child.webContents, opened.context);
    child.close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(child.isDestroyed(), false);
    preventUnload = false; status = 'blocked'; child.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(child.isDestroyed(), false, 'a prior permitted close is not a future close permit');
    assert.equal(f.sent.filter(([channel]) => channel === 'resource-window:checkpoint-request').length, 2);
    status = 'confirmed'; child.close(); await new Promise(resolve => setImmediate(resolve)); assert.equal(child.isDestroyed(), true);
  } finally { f.host.dispose(); }
});
test('wrong sender/generation and failed native load release only the affected view', async () => {
  const f = fixture(), opened = await f.host.open(f.source, request), child = f.children[0];
  assert.equal(f.host.ready(f.source, opened.context).status, 'scope_denied');
  assert.equal(f.host.ready(child.webContents, { ...opened.context, generation: 0 }).status, 'stale_view');
  f.roles.delete(f.source); assert.equal((await f.host.returnToSource(child.webContents, opened.context)).status, 'source_unavailable');
  f.host.dispose(); assert.equal(child.isDestroyed(), true);
  const broken = fixture(); broken.rejectLoad(); assert.equal((await broken.host.open(broken.source, request)).ok, false);
  assert.equal(broken.children[0].isDestroyed(), true); broken.host.dispose();
});
test('resource role cannot call main/settings/execute transports; main cannot use the child read transport', () => {
  const registry = createTrustedWindowRegistry(), sender = { on() {}, once() {}, removeListener() {}, setWindowOpenHandler() {}, mainFrame: { url: 'https://app.local/index.html', parent: null } };
  registry.registerWindow({ window: { webContents: sender }, role: 'resource', allowedLocations: ['https://app.local/index.html'] });
  const event = { sender, senderFrame: sender.mainFrame };
  for (const key of ['settings:get-sync', 'file:read', 'file:write', 'chat:send', 'resource-window:open']) assert.throws(() => registry.authorize({ entry: getDesktopIpcPolicy(key), event }));
  assert.equal(registry.authorize({ entry: getDesktopIpcPolicy('resource-window:read'), event }).role, 'resource');
  assert.deepEqual(getDesktopIpcPolicy('resource-window:read').allowedWindowRoles, ['resource']); registry.dispose();
});
test('dedicated preload exposes only a read-only resource bridge and avoids initial blank-document IPC', () => {
  let exposed, calls = [];
  const ipc = { invoke: (...args) => { calls.push(args); return Promise.resolve({}); }, sendSync: (...args) => { calls.push(args); return {}; } };
  runInNewContext(readFileSync(new URL('../preload/resource-window.source.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (key, value) => { assert.equal(key, 'peerResource'); exposed = value; } }, ipcRenderer: ipc }), location: { href: 'about:blank' },
  });
  assert.equal(calls.length, 0); assert.equal(exposed.writeFile, undefined); assert.equal(exposed.getSettings, undefined); assert.equal(exposed.submitInput, undefined);
  exposed.read({ identity: 'identity', operation: 'content' }); assert.equal(calls[0][0], 'resource-window:read');
});

test('dispose retires an unsettled native load immediately without waiting for the renderer', { timeout: 1000 }, async () => {
  const f = fixture(); f.hangLoad();
  const pending = f.host.open(f.source, request);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.children.length, 1);
  } finally { f.host.dispose(); }
  assert.equal((await pending).ok, false);
  assert.equal(f.children[0].isDestroyed(), true);
});

test('restart recovery is explicit, owner-bound, re-resolves its source and creates new live identities', async () => {
  const first = fixture(); let history;
  try {
    const opened = await first.host.open(first.source, request), child = first.children[0]; first.host.ready(child.webContents, opened.context);
    assert.equal(first.host.navigation(child.webContents, { identity: opened.context, sequence: 1, navigation: { top: 444, left: 0, mode: 'source' } }).persisted, true);
    assert.equal(first.host.navigation(child.webContents, { identity: opened.context, sequence: 1, navigation: { top: 1, left: 0 } }).status, 'stale_view');
    history = first.history(); assert.equal(history.entries[0].request.navigation.top, 444);
    const next = fixture({ history });
    try {
      assert.equal(next.children.length, 0, 'construction never restores windows');
      const list = await next.host.history(next.source, { workspaceId: 'bot' }); assert.equal(list.entries.length, 1); assert.equal(next.children.length, 0, 'listing never opens files/windows');
      assert.equal((await next.host.history(next.source, { workspaceId: 'other' })).entries.length, 0);
      const reopened = await next.host.restore(next.source, { workspaceId: 'bot', id: list.entries[0].id });
      assert.equal(reopened.ok, true); assert.notEqual(reopened.context.viewId, opened.context.viewId); assert.notEqual(reopened.context.windowId, opened.context.windowId);
      assert.equal(reopened.context.navigation.top, 444); assert.equal(reopened.context.resource.mode, 'source');
      next.root('/relocated');
      assert.equal((await next.host.restore(next.source, { workspaceId: 'bot', id: list.entries[0].id })).status, 'source_changed');
      assert.equal((await next.host.history(next.source, { workspaceId: 'bot' })).entries.length, 1);
    } finally { next.host.dispose(); }
  } finally { first.host.dispose(); }
});
test('storage failure does not stop reading; forgetting an open view prevents close from recreating its history', async () => {
  const broken = fixture({ failStorage: true });
  try { const opened = await broken.host.open(broken.source, request); assert.equal(opened.ok, true); assert.equal(opened.persisted, false); }
  finally { broken.host.dispose(); }
  const f = fixture();
  try {
    const opened = await f.host.open(f.source, request), child = f.children[0]; f.host.ready(child.webContents, opened.context);
    const record = (await f.host.history(f.source, { workspaceId: 'bot' })).entries[0];
    assert.equal((await f.host.forget(f.source, { workspaceId: 'bot', id: record.id })).ok, true);
    f.host.close(child.webContents, opened.context); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await f.host.history(f.source, { workspaceId: 'bot' })).entries.length, 0);
  } finally { f.host.dispose(); }
});
