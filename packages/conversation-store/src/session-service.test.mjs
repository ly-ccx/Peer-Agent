import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';
import {
  createBotSqliteAdapter,
  createClassicJsonlAdapter,
  createSessionService,
} from './session-service.mjs';

function tempStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'session-service-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createConversationStore({ storeDir: dir }) };
}

test('append materializes a preview and listMeta ignores a broken transcript', async (t) => {
  const { dir, store } = tempStore(t);
  const classic = createSessionService(createClassicJsonlAdapter(store));
  const created = store.createConversation({ title: '窗口契约' });
  const appended = await classic.append({
    conversationId: created.id,
    message: { id: 'm-1', role: 'user', content: `  ${'项'.repeat(100)}  ` },
  });
  assert.equal(Object.hasOwn(appended, 'messages'), false);
  assert.equal(Object.hasOwn(appended.meta, 'messages'), false);
  assert.equal(appended.preview.availability, 'ready');
  assert.equal(appended.preview.contentRevision, appended.meta.contentRevision);
  assert.equal(Array.from(appended.preview.excerpt).length, 80);
  assert.equal(appended.preview.excerpt, '项'.repeat(80));

  store.getPersistedConversationHistory = () => { throw new Error('FULL_HISTORY'); };
  store.getConversation = () => { throw new Error('FULL_HISTORY'); };
  writeFileSync(path.join(dir, `${created.id}.jsonl`), '{not-json');
  const listed = await classic.listMeta();
  const row = listed.find((item) => item.id === created.id);
  assert.equal(row.preview.excerpt, '项'.repeat(80));
  assert.equal(row.availability, 'ready');
  assert.equal(JSON.stringify(listed).includes('not-json'), false);
});

test('preview reads share one index parse and still observe the next append', (t) => {
  const { store } = tempStore(t);
  const ids = [];
  for (let index = 0; index < 30; index += 1) {
    const created = store.createConversation({ title: `bot ${index}` });
    store.appendMessage(created.id, { id: `m-${index}`, role: 'user', content: `hello ${index}` }, { returnMessages: false });
    ids.push(created.id);
  }
  for (let round = 0; round < 3; round += 1) {
    for (const id of ids) assert.equal(store.readSessionPreview(id).excerpt, `hello ${ids.indexOf(id)}`);
  }
  store.appendMessage(ids[4], { id: 'next', role: 'assistant', content: 'updated excerpt' }, { returnMessages: false });
  assert.equal(store.readSessionPreview(ids[4]).excerpt, 'updated excerpt');
  assert.equal(store.readSessionPreview(ids[3]).excerpt, 'hello 3');
});

test('updateMessageById and replaceMessages refresh the materialized excerpt with the revision', (t) => {
  const { store } = tempStore(t);
  const conversation = store.createConversation({ title: 'revise' });
  store.appendMessage(conversation.id, { id: 'u', role: 'user', content: '问题' }, { returnMessages: false });
  store.appendMessage(conversation.id, { id: 'a', role: 'assistant', content: '草稿' }, { returnMessages: false });
  const updated = store.updateMessageById(conversation.id, 'a', { content: '定稿说明' });
  assert.equal(updated.preview.excerpt, '定稿说明');
  assert.equal(updated.preview.contentRevision, updated.contentRevision);
  assert.equal(Object.hasOwn(store.readSessionPreview(conversation.id), 'messages'), false);
  const replaced = store.replaceMessages(conversation.id, [
    { id: 'u2', role: 'user', content: '换成这句' },
  ]);
  assert.equal(replaced.preview.excerpt, '换成这句');
  assert.equal(replaced.preview.messageId, 'u2');
  assert.equal(store.listConversations().find((row) => row.id === conversation.id).preview.excerpt, '换成这句');
});

test('classic and bot windows share the contract and full:true stays diagnostic', async (t) => {
  const { store } = tempStore(t);
  const conversation = store.createConversation({ title: 'both', role: 'project_agent', workspaceId: 'bot-1' });
  for (let index = 0; index < 5; index += 1) {
    store.appendMessage(conversation.id, {
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      kind: index % 2 === 0 ? 'user_input' : 'agent_reply',
      content: `line ${index}`,
    }, { returnMessages: false });
  }
  let interactionCalls = 0;
  const originalWindow = store.readConversationWindow.bind(store);
  store.readConversationWindow = (id, options) => {
    if (options?.full === true) return originalWindow(id, options);
    return originalWindow(id, options);
  };
  store.readInteractionPage = async (id, params) => {
    interactionCalls += 1;
    assert.equal(params.full, undefined);
    const page = originalWindow(id, { limit: params.limit });
    return { messages: page.window, nextCursor: page.cursor, contentRevision: page.meta.contentRevision, sourceVersion: 'sqlite' };
  };
  const classic = createSessionService(createClassicJsonlAdapter(store));
  const bot = createSessionService(createBotSqliteAdapter(store));
  const classicPage = await classic.getWindow({ conversationId: conversation.id, limit: 2 });
  const botPage = await bot.getWindow({ conversationId: conversation.id, limit: 2 });
  assert.equal(classicPage.diagnostic, undefined);
  assert.equal(botPage.diagnostic, undefined);
  assert.deepEqual(classicPage.window.map((row) => row.id), ['m-3', 'm-4']);
  assert.equal(botPage.sourceVersion, 'sqlite');
  assert.equal(interactionCalls, 1);
  assert.equal(Object.hasOwn(classicPage, 'messages'), false);
  assert.equal(Object.hasOwn(botPage, 'messages'), false);
  const diagnostic = await classic.getWindow({ conversationId: conversation.id, full: true, limit: 2 });
  assert.equal(diagnostic.diagnostic, true);
  assert.deepEqual(diagnostic.window.map((row) => row.id), ['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
  const botDiagnostic = await bot.getWindow({ conversationId: conversation.id, full: true, limit: 2 });
  assert.equal(botDiagnostic.diagnostic, true);
  assert.equal(botDiagnostic.window.length, 5);
});

test('subscribeRevision reports the revision and omits message bodies', async (t) => {
  const events = [];
  const store = {
    readSessionPreview: () => ({ contentRevision: 7, excerpt: '当前', availability: 'ready' }),
    subscribeChanges(listener) {
      listener({
        conversationId: 'c',
        changeType: 'messages-updated',
        workspacePath: '/workspace',
        writerPid: 4,
        revision: 'r1',
        messages: [{ content: 'must not leak' }],
      });
      return () => {};
    },
  };
  const stop = createSessionService(createClassicJsonlAdapter(store)).subscribeRevision({}, (event) => {
    events.push(event);
  });
  t.after(stop);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events.length, 1);
  assert.equal(events[0].contentRevision, 7);
  assert.equal(events[0].reason, 'append');
  assert.equal(events[0].conversationId, 'c');
  assert.equal(JSON.stringify(events[0]).includes('must not leak'), false);
  assert.equal(Object.hasOwn(events[0], 'messages'), false);
});

test('missing preview is rebuilding and the list does not scan the transcript synchronously', (t) => {
  const { dir, store } = tempStore(t);
  const conversation = store.createConversation({ title: 'legacy' });
  const indexFile = path.join(dir, 'index.jsonl');
  const rows = store.listConversations().map((row) => {
    if (row.id !== conversation.id) return row;
    const { preview, availability, ...rest } = row;
    return rest;
  });
  writeFileSync(indexFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(path.join(dir, `${conversation.id}.jsonl`), '{');
  const reopened = createConversationStore({ storeDir: dir });
  const [listed] = reopened.listConversations().filter((row) => row.id === conversation.id);
  assert.equal(listed.availability, 'rebuilding');
  assert.equal(listed.preview.excerpt, '');
  assert.equal(listed.preview.contentRevision, conversation.contentRevision ?? 0);
});
