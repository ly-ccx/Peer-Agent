import test from 'node:test';
import assert from 'node:assert/strict';
import { botNarration } from './botNarrationState.ts';
import { attachBotProcesses } from './botActivityState.ts';
import { conversationRows, normalizeBotMessage } from './botConversationState.ts';

const message = (raw: Record<string, unknown>) => normalizeBotMessage(raw)!;
const rounds = [
  { text: '我先核对说明。', toolCalls: [{ name: 'read_file', input: null, result: null }] },
  { text: '找到两个需要核查的地方。', toolCalls: [] },
];
const updates = rounds.map((round, index) => ({ id: `text-${index + 1}`, text: round.text }));
test('public updates survive canonical handoff and reading persisted history in order', () => {
  const turn = message({ id: 't', kind: 'agent_turn', turnKind: 'user', rounds, publicUpdates: updates });
  const reply = message({ id: 'r', kind: 'agent_reply', turnId: 't', content: '核对完成，结论如下。' });
  const rows = attachBotProcesses(conversationRows([reply, turn]), [reply, turn], null);
  const row = rows.find(row => row.type === 'message');
  if (row?.type !== 'message') throw Error('reply missing');
  assert.deepEqual(row.narration?.map(segment => segment.text), rounds.map(round => round.text));
  assert.equal(row.message.content, '核对完成，结论如下。');
});
test('wake and legacy internal text never become conversational progress', () => {
  for (const turnKind of ['wake', 'user', undefined]) {
    const turn = message({ id: 't', kind: 'agent_turn', turnKind, rounds });
    const reply = message({ id: 'r', kind: 'agent_reply', turnId: 't', content: 'final' });
    const row = attachBotProcesses(conversationRows([turn, reply]), [turn, reply], null).find(row => row.type === 'message');
    if (row?.type !== 'message') throw Error('reply missing');
    assert.deepEqual(row.narration, []);
  }
});
test('automatic wake stays quiet; explicitly persisted manual retry updates survive history', () => {
  // The host omits publicUpdates for automatic wakes and writes them for an
  // explicit retry. turnKind remains wake in both cases to retain its authority.
  const turn = message({ id: 't', kind: 'agent_turn', turnKind: 'wake', rounds });
  const reply = message({ id: 'r', kind: 'agent_reply', turnId: 't', content: 'final' });
  const row = attachBotProcesses(conversationRows([turn, reply]), [turn, reply], null).find(row => row.type === 'message');
  if (row?.type !== 'message') throw Error('reply missing');
  assert.deepEqual(row.narration, []);
  const retry = message({ id: 't', kind: 'agent_turn', turnKind: 'wake', rounds, publicUpdates: updates });
  const retryRow = attachBotProcesses(conversationRows([retry, reply]), [retry, reply], null).find(row => row.type === 'message');
  if (retryRow?.type !== 'message') throw Error('retry reply missing');
  assert.deepEqual(retryRow.narration, updates);
});
test('public history decoding rejects duplicate IDs and excess text', () => {
  const decoded = message({ id: 'decoded', kind: 'agent_turn', publicUpdates: [null, { id: '', text: 'bad' },
    { id: 'a', text: 'a' }, { id: 'a', text: 'duplicate' }, { id: 'b', text: 'x'.repeat(40000) }] });
  assert.equal(decoded.publicUpdates?.length, 2);
  assert.equal(decoded.publicUpdates?.reduce((sum, update) => sum + update.text.length, 0), 32000);
});
test('fallback and stopped partial text appears once without removing earlier updates', () => {
  const last = rounds[1].text;
  assert.deepEqual(botNarration(updates, ` ${last}\n`).map(segment => segment.text), [rounds[0].text]);
  assert.equal(botNarration(updates, '其它结论').length, 2);
});
test('multiple canonical replies cannot repeat the same turn narration', () => {
  const turn = message({ id: 't', kind: 'agent_turn', turnKind: 'user', rounds, publicUpdates: updates });
  const a = message({ id: 'a', kind: 'agent_reply', turnId: 't', content: 'a' });
  const b = message({ id: 'b', kind: 'agent_reply', turnId: 't', content: 'b' });
  const rows = attachBotProcesses(conversationRows([turn, a, b]), [turn, a, b], null).filter(row => row.type === 'message');
  assert.equal(rows[0].narration?.length, 2);
  assert.deepEqual(rows[1].narration, []);
});
