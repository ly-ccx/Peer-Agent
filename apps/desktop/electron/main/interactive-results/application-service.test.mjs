import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { validateDraft } from '@peer-agent/interactive-content';
import { createInteractiveResultStore, createInteractiveStateStore } from '@peer-agent/runtime-node/interactive-results';
import { createDesktopInteractiveApplication } from './application-service.mjs';
import { createResourceWindowController } from '../resource-window-controller.mjs';
import { createTrustedWindowRegistry } from '../ipc/trusted-window-registry.mjs';
import { getDesktopIpcPolicy } from '../../ipc/channels.mjs';

const owner = { workspaceId: 'bot-a', conversationId: 'parent-a' }, location = 'https://app.local/index.html';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const rootDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'interactive-application-')));
  const resultStore = createInteractiveResultStore({ rootDir, assertCompatibility: () => true }), stateStore = createInteractiveStateStore({ resultStore });
  const runtime = { resultStore, stateStore }, windows = [], packets = [];
  const trusted = createTrustedWindowRegistry();
  let activeRuntime = runtime, conversationId = owner.conversationId, legacyHistory, fileReads = 0, checkpoint = 'confirmed', host;
  const sender = () => Object.assign(new EventEmitter(), { mainFrame: { url: location, parent: null }, destroyed: false, isDestroyed() { return this.destroyed; }, setWindowOpenHandler() {},
    send(channel, payload) { packets.push({ sender: this, channel, payload });
      if (channel === 'resource-window:checkpoint-request') queueMicrotask(() => host.acknowledgeCheckpoint(this, { ...payload, status: checkpoint }));
      if (channel === 'resource-window:return-target') queueMicrotask(() => host.acknowledgeReturn(this, { requestId: payload.requestId, identity: payload.context, status: 'returned' }));
    } });
  const main = sender();
  const mainWindow = { webContents: main, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {} };
  trusted.registerWindow({ window: mainWindow, role: 'main', allowedLocations: [location] });
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = sender(); this.destroyed = false; windows.push(this); }
    isDestroyed() { return this.destroyed; }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
    show() {}
    destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
    close() { let prevented = false; this.emit('close', { preventDefault() { prevented = true; } }); if (!prevented) this.destroy(); }
    static fromWebContents(contents) { return contents === main ? mainWindow : windows.find(win => win.webContents === contents); }
  }
  const app = createDesktopInteractiveApplication({ getRole: sender => trusted.getRole(sender), getOwner: workspaceId => workspaceId === owner.workspaceId && conversationId ? { conversationId } : null,
    getRuntime: () => activeRuntime, getNativeBinding: sender => host.interactiveBinding(sender) });
  host = createResourceWindowController({ BrowserWindow: Window, trustedWindows: trusted, rendererLocation: location, preloadPath: '/app/resource-window.cjs', interactiveResources: app,
    getOwner: async () => ({ conversationId }), resolveDocument: async ref => ({ ok: true, root: '/repo', target: ref.path }),
    readHistory: () => legacyHistory, writeHistory: value => { legacyHistory = structuredClone(value); },
    fileAccess: { readFile: async ({ documentReference: ref }) => { fileReads++; return { ok: true, metadataOnly: !!ref.metadataOnly, resolvedPath: ref.path, resolvedFrom: '/repo', content: '' }; } } });
  const draft = { publication: { kind: 'create' }, title: 'Trial from actual publication', textFallback: 'Unverified model trial.', inputs: [],
    program: '$x=2\nroot=Col([NumberInput("x","Divisor",$x,0,10,1),Metric("Ratio",10/$x)])' };
  const receipt = resultStore.commitPublication({ owner, source: { conversationId: 'worker-a', planId: 'plan-a', sessionId: 'session-a', toolCallId: 'publish-a', executionEpoch: 'epoch-a' },
    draft, content: await validateDraft(draft), provenance: [], dataLevel: 'D3_private', grant: { toolCallId: 'publish-a', grantId: 'grant-a', granted: true } }, () => true);
  resultStore.markIndexed(receipt.callRef, receipt.indexEntry);
  const resource = { kind: 'interactive', reference: receipt.reference };
  t.after(() => { app.dispose(); host.dispose(); trusted.dispose(); stateStore.close(); resultStore.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const openNative = async () => { const result = await host.open(main, { resource, sourceTabId: 'interactive-tab', navigation: { top: 180, left: 0 } }); assert.equal(result.ok, true); return { result, window: windows.at(-1) }; };
  return { app, host, trusted, main, windows, packets, runtime, resource, receipt, openNative, sender,
    setOwner: value => { conversationId = value; }, setRuntime: value => { activeRuntime = value; }, setCheckpoint: value => { checkpoint = value; },
    fileReads: () => fileReads, legacyHistory: () => legacyHistory, rewriteLegacy: value => { legacyHistory = value; } };
}

test('native view uses the real window binding, enforces one writer and cannot reach file APIs', async t => {
  const f = await fixture(t), mainView = await f.app.open(f.main, { reference: f.resource.reference, requestId: 'main-open' });
  assert.equal(mainView.ok, true);
  const first = f.app.acquire(f.main, { handle: mainView.handle, expectedRevision: 0 }); assert.equal(first.ok, true);
  const { result, window } = await f.openNative(), native = window.webContents;
  assert.equal(result.context.title, 'Trial from actual publication'); assert.equal(result.context.resource.reference.path, undefined);
  assert.equal((await f.app.open(native, { reference: f.resource.reference, requestId: 'not-ready' })).code, 'interactive_scope_denied');
  assert.equal(f.host.ready(native, result.context).ok, true);
  assert.equal((await f.app.open(native, { reference: { ...f.resource.reference, resultId: 'other-result' }, requestId: 'substitute' })).code, 'interactive_scope_denied');
  const opened = await f.app.open(native, { reference: f.resource.reference, requestId: 'native-open' }); assert.equal(opened.ok, true);
  assert.equal(f.app.acquire(native, { handle: opened.handle, expectedRevision: 0 }).code, 'interactive_writer_busy');
  const successor = f.app.acquire(native, { handle: opened.handle, expectedRevision: 0, takeover: true }); assert.equal(successor.ok, true);
  assert.equal(f.app.save(f.main, { handle: mainView.handle, writer: first.writer, expectedRevision: 0, requestId: 'late', values: { $x: 9 }, inputDrafts: {} }).code, 'interactive_writer_stale');
  const saved = f.app.save(native, { handle: opened.handle, writer: successor.writer, expectedRevision: 0, requestId: 'native-save', values: { $x: 5 }, inputDrafts: {} });
  assert.equal(saved.state.stateRevision, 1);
  assert.equal((await f.host.read(native, { identity: result.context, operation: 'content' })).status, 'scope_denied');
  assert.equal(f.fileReads(), 0); assert.equal(f.legacyHistory(), undefined);
  assert.equal(f.app.readLayout(native, { owner }).code, 'interactive_scope_denied');
  assert.equal(f.app.writeLayout(f.main, { owner, expectedRevision: 0, order: ['interactive:fixed'], recent: [], interactive: { tabs: [{ id: 'fixed', reference: f.resource.reference }], activeTabId: 'fixed' } }).ok, true);
  f.setOwner('new-conversation');
  assert.equal(f.app.readLayout(f.main, { owner }).code, 'interactive_scope_denied');
  assert.equal(f.app.writeLayout(f.main, { owner, expectedRevision: 1, order: [], recent: [], interactive: { tabs: [], activeTabId: null } }).code, 'interactive_scope_denied');
  assert.equal(f.app.readState(native, { handle: opened.handle }).code, 'interactive_view_stale');
  assert.equal(f.app.save(native, { handle: opened.handle, writer: successor.writer, expectedRevision: 1, requestId: 'wrong-owner', values: { $x: 8 }, inputDrafts: {} }).code, 'interactive_view_stale');
  f.setOwner(owner.conversationId); assert.equal(f.runtime.stateStore.read(f.resource.reference, () => true).values.$x, 5);
});

test('reload, crash and runtime replacement retire only the affected sender lifetime and preserve confirmed state', async t => {
  const f = await fixture(t), { result, window } = await f.openNative(), native = window.webContents;
  f.host.ready(native, result.context);
  const opened = await f.app.open(native, { reference: f.resource.reference, requestId: 'native-open' });
  const acquired = f.app.acquire(native, { handle: opened.handle, expectedRevision: 0 });
  assert.equal(f.app.save(native, { handle: opened.handle, writer: acquired.writer, expectedRevision: 0, requestId: 'save', values: { $x: 4 }, inputDrafts: {} }).ok, true);
  native.emit('did-start-navigation', {}, location, false, false);
  assert.equal(f.app.readState(native, { handle: opened.handle }).ok, true, 'subframe navigation does not retire the view');
  native.emit('did-start-navigation', {}, location, false, true);
  assert.equal(f.app.readState(native, { handle: opened.handle }).code, 'interactive_view_stale');
  const resumed = await f.app.open(native, { reference: f.resource.reference, requestId: 'reloaded' });
  assert.equal(resumed.state.values.$x, 4); assert.equal(f.app.acquire(native, { handle: resumed.handle, expectedRevision: 1 }).ok, true);
  native.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(window.isDestroyed(), true); assert.equal(f.app.readState(native, { handle: resumed.handle }).code, 'interactive_scope_denied');
  const main = await f.app.open(f.main, { reference: f.resource.reference, requestId: 'main' });
  assert.equal(main.state.values.$x, 4); assert.equal(f.app.acquire(f.main, { handle: main.handle, expectedRevision: 1 }).ok, true);
  f.setRuntime({ ...f.runtime });
  assert.equal(f.app.readState(f.main, { handle: main.handle }).code, 'interactive_view_stale');
  const restarted = await f.app.open(f.main, { reference: f.resource.reference, requestId: 'host-restarted' });
  assert.equal(f.app.acquire(f.main, { handle: restarted.handle, expectedRevision: 1 }).ok, true);
});

test('mixed recovery merges actual protected history with legacy Settings without letting either writer erase the other', async t => {
  const f = await fixture(t), document = { resource: { kind: 'document', mode: 'preview', reference: { workspaceId: owner.workspaceId, path: '/repo/a.md' } } };
  const doc = await f.host.open(f.main, document); assert.equal(doc.ok, true);
  const legacy = structuredClone(f.legacyHistory()), reads = f.fileReads();
  const { result, window } = await f.openNative(); f.host.ready(window.webContents, result.context);
  assert.deepEqual(f.legacyHistory(), legacy); assert.equal(f.fileReads(), reads);
  const navigated = f.host.navigation(window.webContents, { identity: result.context, sequence: 1, navigation: { top: 360, left: 0 } }); assert.equal(navigated.persisted, true);
  let history = await f.host.history(f.main, { workspaceId: owner.workspaceId });
  assert.equal(history.ok, true); assert.equal(history.entries.length, 2);
  const entry = history.entries.find(entry => entry.request.resource.kind === 'interactive');
  assert.equal(entry.title, 'Trial from actual publication'); assert.equal(entry.request.navigation.top, 360);
  f.rewriteLegacy({ version: 1, entries: [] });
  history = await f.host.history(f.main, { workspaceId: owner.workspaceId }); assert.equal(history.entries.length, 1); assert.equal(history.entries[0].id, entry.id);
  assert.equal((await f.host.returnToSource(window.webContents, result.context)).returnStatus, 'returned');
  f.setCheckpoint('blocked'); window.close(); await tick(); assert.equal(window.isDestroyed(), false);
  f.setCheckpoint('confirmed'); window.close(); await tick(); assert.equal(window.isDestroyed(), true);
  const restored = await f.host.restore(f.main, { workspaceId: owner.workspaceId, id: entry.id }); assert.equal(restored.ok, true); assert.equal(restored.context.navigation.top, 360);
  assert.equal((await f.host.forget(f.main, { workspaceId: owner.workspaceId, id: entry.id })).ok, true);
  assert.equal((await f.host.history(f.main, { workspaceId: owner.workspaceId })).entries.length, 0);
  assert.equal(f.runtime.resultStore.getVersion(f.resource.reference).content.title, entry.title);
});

test('interactive IPC policy excludes guests, wrong origins and subframes, and layout is main-only', async t => {
  const f = await fixture(t), { window } = await f.openNative(), native = window.webContents;
  const event = { sender: native, senderFrame: native.mainFrame };
  for (const channel of ['interactive-results:open', 'interactive-results:cancel-open', 'interactive-results:save', 'interactive-results:prepare-followup']) {
    const entry = getDesktopIpcPolicy(channel);
    assert.doesNotThrow(() => f.trusted.authorize({ entry, event }));
    assert.throws(() => f.trusted.authorize({ entry, event: { ...event, senderFrame: { url: location, parent: native.mainFrame } } }), { code: 'ERR_PEER_DESKTOP_IPC_UNAUTHORIZED' });
    const original = native.mainFrame.url; native.mainFrame.url = 'https://untrusted.local/index.html';
    assert.throws(() => f.trusted.authorize({ entry, event }), { code: 'ERR_PEER_DESKTOP_IPC_UNAUTHORIZED' }); native.mainFrame.url = original;
  }
  for (const channel of ['resource-presentation:read-layout', 'resource-presentation:write-layout', 'file:write', 'chat:send']) {
    assert.throws(() => f.trusted.authorize({ entry: getDesktopIpcPolicy(channel), event }), { code: 'ERR_PEER_DESKTOP_IPC_UNAUTHORIZED' });
  }
  const quick = f.sender(); f.trusted.registerWindow({ window: { webContents: quick }, role: 'quick-chat', allowedLocations: [location] });
  assert.equal((await f.app.open(quick, { reference: f.resource.reference, requestId: 'guest' })).code, 'interactive_scope_denied');
  f.app.dispose(); assert.equal((await f.app.open(f.main, { reference: f.resource.reference, requestId: 'after-dispose' })).code, 'interactive_scope_denied');
});
