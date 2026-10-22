import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore } from './index.mjs';

test('public interaction queries exclude private rounds and paginate visible messages before loading process facts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interactions-'));
  try {
    const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
    const conversation = store.createConversation({ role: 'project_agent', workspacePath: root });
    const append = message => store.appendMessage(conversation.id, message, { returnMessages: false });
    append({ id: 'u', role: 'user', kind: 'user_input', content: '公开问题' });
    for (let i = 0; i < 80; i++) append({ id: `t${i}`, role: 'assistant', kind: 'agent_turn', content: 'PRIVATE', userInputs: [{ inputId: 'u' }], rounds: [{ toolCalls: [{ name: 'read_file', result: 'SECRET'.repeat(2000) }] }] });
    append({ id: 'r', role: 'assistant', kind: 'agent_reply', content: '公开回复' });
    store.getPersistedConversationHistory = () => assert.fail('public reads must not use the full history API');
    const context = await store.readInteractionContext(conversation.id);
    assert.deepEqual(context.messages.map(m => m.id), ['u', 'r']);
    assert.ok(!JSON.stringify(context).includes('PRIVATE')); assert.ok(!JSON.stringify(context).includes('SECRET'));
    const page = await store.readInteractionPage(conversation.id, { limit: 1 });
    assert.deepEqual(page.messages.map(m => m.id), ['r']); assert.equal(page.nextCursor, 'r');
    const older = await store.readInteractionPage(conversation.id, { limit: 1, before: page.nextCursor });
    assert.equal(older.messages[0].id, 'u');
    const file = path.join(root, 'conversations', `${conversation.id}.jsonl`), bytes = readFileSync(file);
    await store.readInteractionContext(conversation.id); assert.deepEqual(readFileSync(file), bytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public indices observe external append, rewrites and strict provisional-tail exclusion', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-interaction-version-'));
  try {
    const store = createConversationStore({ storeDir: path.join(root, 'conversations') }), c = store.createConversation({});
    store.appendMessage(c.id, { id: 'u', role: 'user', content: 'question' });
    assert.equal((await store.readInteractionContext(c.id)).messages.length, 1);
    store.appendMessage(c.id, { id: 'r', role: 'assistant', content: 'answer' });
    assert.equal((await store.readInteractionContext(c.id)).messages.length, 2);
    const sidecar = path.join(root, 'conversations', `${c.id}.stream.json`);
    writeFileSync(sidecar, JSON.stringify({ version: 1, conversationId: c.id, messageId: 'r', patch: {} }));
    assert.deepEqual((await store.readInteractionContext(c.id)).messages.map(m => m.id), ['u']);
    writeFileSync(sidecar, '{}'); await assert.rejects(store.readInteractionContext(c.id), /BACKGROUND_STREAM_STATE_INVALID/);
    rmSync(sidecar); store.replaceMessages(c.id, [{ id: 'new', role: 'user', content: 'replacement' }]);
    assert.deepEqual((await store.readInteractionContext(c.id)).messages.map(m => m.id), ['new']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('selected process reads only its linked canonical records and survives a lost public index', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-process-'));
  try {
    const store = createConversationStore({ storeDir: path.join(root, 'conversations') }), c = store.createConversation({});
    store.appendMessage(c.id, { id: 'u', kind: 'user_input', role: 'user', content: 'q' });
    store.appendMessage(c.id, { id: 'turn', kind: 'agent_turn', role: 'assistant', rounds: [{ text: 'PRIVATE selected', toolCalls: [] }] });
    store.appendMessage(c.id, { id: 'r', kind: 'agent_reply', role: 'assistant', content: 'answer', turnId: 'turn' });
    store.appendMessage(c.id, { id: 'unrelated', kind: 'agent_turn', role: 'assistant', rounds: [{ text: 'PRIVATE unrelated' }] });
    assert.deepEqual((await store.readInteractionProcess(c.id, { messageId: 'r' })).messages.map(m => m.id), ['turn','r']);
    assert.deepEqual((await store.readInteractionProcess(c.id, { messageId: 'turn' })).messages.map(m => m.id), ['turn','r'], 'a completed live-turn address resolves its public reply and retains the current detail anchor');
    assert.ok(!JSON.stringify(await store.readInteractionPage(c.id)).includes('PRIVATE'));
    rmSync(path.join(root, 'cache'), { recursive: true });
    assert.deepEqual((await store.readInteractionContext(c.id)).messages.map(m => m.id), ['u','r']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
