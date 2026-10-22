import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore } from './index.mjs';
import { DatabaseSync } from './sqlite-runtime.generated.mjs';

test('legacy verdicts stay in canonical process records but never fill public pages or model context', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-verdict-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const c = store.createConversation({ role: 'project_agent' });
  const append = row => store.appendMessage(c.id, row, { returnMessages: false });
  append({ id: 'user', role: 'user', kind: 'user_input', content: 'passed 是什么意思？' });
  await store.readInteractionPage(c.id); // Exercise an already warm cache as well as a cold rebuild.
  for (let i = 0; i < 105; i++) {
    const content = ['passed', 'failed', 'partial', 'unverifiable'][i % 4];
    append({ id: `verdict-${i}`, role: 'assistant', kind: 'system_card', content,
      cards: [{ cardId: `card:verdict:${i}`, kind: 'verdict', content, resolvedState: 'resolved' }] });
  }
  for (const state of ['verifying', 'verified']) append({ id: `activity-${state}`, kind: 'agent_activity', role: 'system',
    agentActivity: { eventId: state, sessionId: 'session', name: '核对任务', state } });
  append({ id: 'mixed', role: 'assistant', kind: 'system_card', cards: [
    { cardId: 'old-verdict', kind: 'verdict', content: 'failed' },
    { cardId: 'permission', kind: 'approval', content: '需要批准', actions: [{ id: 'allow' }] },
  ] });
  append({ id: 'reply', role: 'assistant', kind: 'agent_reply', content: 'passed 表示通过；这次仍有一项未核验。' });
  const file = path.join(root, 'conversations', `${c.id}.jsonl`), bytes = readFileSync(file);
  await store.readInteractionPage(c.id);
  const indices = path.join(root, 'cache', 'read-models', 'interactions');
  const db = new DatabaseSync(path.join(indices, readdirSync(indices)[0], `${c.id}.sqlite`));
  // Simulate an RC25 cache: canonical records are unchanged, but verdicts were indexed as public.
  const rawVerdict = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).find(row => row.id === 'verdict-0');
  const seq = db.prepare('SELECT seq FROM identities WHERE id=?').get(rawVerdict.id).seq;
  db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(seq, rawVerdict.id, rawVerdict.kind, JSON.stringify(rawVerdict));
  db.prepare("UPDATE meta SET value='2' WHERE id='schema'").run();
  db.close();
  for (const cold of [false, true]) {
    if (cold) rmSync(path.join(root, 'cache'), { recursive: true, force: true });
    const page = await store.readInteractionPage(c.id, { limit: 2 });
    assert.deepEqual(page.messages.map(row => row.id), ['mixed', 'reply']);
    assert.deepEqual(page.messages[0].cards.map(card => card.kind), ['approval']);
    const older = await store.readInteractionPage(c.id, { limit: 2, before: page.nextCursor });
    assert.deepEqual(older.messages.map(row => row.id), ['user']);
    assert.equal(older.nextCursor, null);
    assert.deepEqual((await store.readInteractionContext(c.id)).messages.map(row => row.id), ['user', 'reply']);
    const process = await store.readInteractionProcess(c.id, { messageId: 'verdict-0' });
    assert.equal(process.messages[0].cards[0].kind, 'verdict');
    assert.deepEqual(readFileSync(file), bytes);
  }
});

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
