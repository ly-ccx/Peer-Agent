import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationStore } from '../../../../../packages/conversation-store/src/index.mjs';
import { selectionTextHash } from '../../../../../packages/conversation-store/src/selection-reference.mjs';
import { createSelectionIpcRegistrations } from './register-selection-ipc.mjs';
import { createCatalogIpcMain } from './catalog-ipc-main.mjs';
import { createTrustedWindowRegistry } from './trusted-window-registry.mjs';
import { appendSelectionQuote } from '../../../renderer/src/chat/state/selectionQuoteAttachment.ts';
import { toApiMessages } from '../../../renderer/src/chat/state/apiMessageMapping.ts';

function setup(t, role = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'selection-ipc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: root });
  const parent = store.createConversation({ title: 'parent' });
  store.appendMessage(parent.id, { id: 'm1', role: 'assistant', content: 'same same' });
  const sender = new EventEmitter();
  sender.mainFrame = { url: 'https://app.local/index.html', parent: null };
  sender.getURL = () => sender.mainFrame.url;
  sender.setWindowOpenHandler = () => {};
  const windows = createTrustedWindowRegistry();
  windows.registerWindow({ window: { webContents: sender }, role, allowedLocations: [sender.mainFrame.url] });
  const handlers = new Map();
  const ipc = createCatalogIpcMain({ ipcMain: { handle: (key, cb) => handlers.set(key, cb), on() {} }, authorize: windows.authorize });
  let afterRuntime = () => {};
  const resolveRuntimeState = async (id) => {
    const history = store.getPersistedConversationHistory(id);
    afterRuntime();
    return { conversationId: id, contentRevision: history?.contentRevision, status: 'idle' };
  };
  for (const registration of createSelectionIpcRegistrations({ store, resolveRuntimeState, authorizeWindow: windows.authorize })) registration.register(ipc.createOwner(registration.owner));
  const event = { sender, senderFrame: sender.mainFrame };
  const selection = { conversationId: parent.id, messageId: 'm1', blockId: 'content', revision: store.getConversation(parent.id).contentRevision,
    start: 5, end: 9, exactText: 'same', sourceTextHash: selectionTextHash('same same') };
  const invoke = (key, payload, e = event) => Promise.resolve().then(() => handlers.get(`selection:${key}`)(e, payload));
  return { root, store, parent, selection, invoke, sender, event, setAfterRuntime: (fn) => { afterRuntime = fn; } };
}

for (const action of ['quote', 'create-child']) test(`IPC ${action}: real catalog/service/store, precise range, no model run or copied caller`, async (t) => {
  const { store, parent, selection, invoke } = setup(t);
  const payload = { conversationId: parent.id, requestId: 'open-1', selection, caller: { conversationId: 'forged' }, runtimeState: { status: 'running' }, permissions: ['*'] };
  const result = await invoke(action, payload);
  const reference = action === 'quote' ? result : result.selectionOrigin.reference;
  assert.equal(reference.start, 5);
  assert.equal(reference.exactText, 'same');
  assert.equal(reference.permissions, undefined);
  if (action === 'quote') assert.equal(store.listSelectionChildren(parent.id).length, 0);
  else {
    assert.equal((await invoke(action, payload)).id, result.id);
    const page = await invoke('list-children', { conversationId: parent.id });
    assert.equal(page.items[0].id, result.id);
    assert.equal(page.items[0].lifecycle, 'draft');
    assert.equal(page.items[0].sourceReference.id, reference.id);
    await invoke('save-draft', { conversationId: result.id, text: 'child draft', referenceIds: [reference.id] });
    assert.equal(store.getConversation(result.id).selectionDraft.text, 'child draft');
    assert.deepEqual((await invoke('read-child', { conversationId: parent.id, childId: result.id })).messages, []);
    await assert.rejects(invoke('read-child', { conversationId: result.id, childId: parent.id }), /SESSION_NOT_DIRECT_CHILD/);
    await assert.rejects(invoke('save-draft', { conversationId: parent.id, childId: result.id, text: 'attack', referenceIds: [] }), /SESSION_DRAFT_NOT_OWNED/);
  }
});

for (const sourceRole of ['user', 'assistant']) for (const existing of [false, true]) {
  test(`quote IPC → composer → disk reopen → API: ${sourceRole} × existing=${existing}`, async (t) => {
    const { root, store, parent, invoke } = setup(t);
    const content = 'prefix 唯一选区😀 suffix';
    store.appendMessage(parent.id, { id: 'source', role: sourceRole, content });
    const exactText = '唯一选区😀';
    const reference = await invoke('quote', { conversationId: parent.id, selection: {
      conversationId: parent.id, messageId: 'source', blockId: 'content',
      revision: store.getConversation(parent.id).contentRevision, start: 7,
      end: 7 + exactText.length, exactText, sourceTextHash: selectionTextHash(content),
    } });
    const attachments = appendSelectionQuote(existing ? [{ id: 'prior', name: 'prior.txt',
      kind: 'text', mimeType: 'text/plain', text: 'prior-attachment', size: 16 }] : [], reference);
    store.appendMessage(parent.id, { id: 'sent', role: 'user', content: '原草稿问题', attachments });
    const reopened = createConversationStore({ storeDir: root });
    const sent = reopened.getConversation(parent.id).messages.find((message) => message.id === 'sent');
    assert.deepEqual(sent.attachments.at(-1).selectionReference, reference);
    const api = toApiMessages([sent]);
    assert.equal(api.length, 1);
    assert.equal(api[0].role, 'user');
    const wire = JSON.stringify(api);
    assert.equal(wire.split(exactText).length - 1, 1);
    assert.ok(wire.includes('原草稿问题'));
    if (existing) assert.ok(wire.includes('prior-attachment'));
    assert.equal(reopened.listSelectionChildren(parent.id).length, 0);
  });
}

for (const action of ['quote', 'create-child']) for (const denied of ['unregistered', 'subframe', 'quick-chat', 'navigated-during-await']) {
  test(`IPC ${action}: rejects ${denied} before returning data or creating a child`, async (t) => {
    const { invoke, parent, selection, event, sender, store, setAfterRuntime } = setup(t, denied === 'quick-chat' ? 'quick-chat' : 'main');
    let e = event;
    if (denied === 'unregistered') e = { sender: {}, senderFrame: sender.mainFrame };
    if (denied === 'subframe') e = { ...event, senderFrame: { url: sender.mainFrame.url, parent: sender.mainFrame } };
    if (denied === 'navigated-during-await') setAfterRuntime(() => { sender.mainFrame.url = 'https://evil.test/'; });
    const message = {
      unregistered: 'IPC sender is not a registered application window',
      subframe: 'IPC call did not originate from the trusted top frame',
      'quick-chat': 'IPC channel is not allowed for this window role',
      'navigated-during-await': 'IPC call originated from an untrusted location',
    }[denied];
    await assert.rejects(invoke(action, { conversationId: parent.id, selection, requestId: 'bad' }, e), { name: 'DesktopIpcAuthorizationError', message });
    assert.equal(store.listSelectionChildren(parent.id).length, 0);
  });
}
