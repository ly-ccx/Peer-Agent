import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { hideAcknowledgedQuestions } from './botQuestionState.ts';
import {
  conversationRows,
  normalizeBotMessage,
  projectConversationRows,
  windowConversationRows,
  type BotChatMessage,
  type ConversationProjection,
} from './botConversationState.ts';

function history(count: number): BotChatMessage[] {
  const messages: BotChatMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const last = index === count - 1;
    const user = index % 2 === 0 && !last;
    const message = normalizeBotMessage({
      id: `m-${index}`,
      kind: user ? 'user_input' : 'agent_reply',
      role: user ? 'user' : 'assistant',
      content: last ? '正在写' : (user ? `问题 ${index}` : `回答 ${index}`),
      createdAt: '2026-11-07T03:00:00.000Z',
      ...(index === 0 ? { sources: ['session-a'] } : {}),
    });
    assert.ok(message);
    messages.push(message);
  }
  return messages;
}

test('streaming the tail keeps one full projection while history and chunk count grow', () => {
  const chunks = 20;
  for (const count of [200, 1000, 4000]) {
    let messages = history(count);
    let projection: ConversationProjection | null = null;
    let full = 0;
    let tail = 0;
    let identityComparisons = 0;
    const started = performance.now();
    for (let index = 0; index <= chunks; index += 1) {
      const projected = projectConversationRows(messages, projection);
      identityComparisons += projected.identityComparisons;
      if (projected.projection === 'full') full += 1;
      else tail += 1;
      projection = projected;
      if (index === chunks) break;
      const next = messages.slice();
      const last = next[next.length - 1]!;
      next[next.length - 1] = { ...last, content: `${last.content}一点` };
      messages = next;
    }
    const elapsed = performance.now() - started;
    const rows = projection!.rows;
    const windowed = windowConversationRows(rows, rows.length - 1, 80);
    console.info(`tail-projection history=${count} chunks=${chunks} full=${full} tail=${tail} identityComparisons=${identityComparisons} perChunk=${count - 1} window=${windowed.rows.length} ms=${elapsed.toFixed(1)}`);
    assert.equal(full, 1, `history ${count} rescanned`);
    assert.equal(tail, chunks);
    assert.equal(identityComparisons, chunks * (count - 1), 'each chunk still compares every prefix object');
    assert.equal(windowed.rows.length, count <= 200 ? count : 80);
    assert.deepEqual(rows, conversationRows(messages));
    const tailRow = rows.at(-1);
    assert.equal(tailRow?.type, 'message');
    if (tailRow?.type === 'message') assert.equal(tailRow.message.content.endsWith('一点'), true);
    const prefix = rows[0];
    const again = projectConversationRows(messages, projection);
    assert.equal(again.projection, 'tail');
    assert.equal(again.rows[0], prefix, 'unchanged rows keep their identity');
  }
});

test('tool source, folded activity and an intermediate edit each return to a full projection', () => {
  const activity = { eventId: 'evt-1', sessionId: 'session-a', name: '核对', state: 'started' };
  const messages = [
    normalizeBotMessage({ id: 'u', kind: 'user_input', role: 'user', content: '开始', createdAt: '2026-11-07T03:00:00.000Z' })!,
    normalizeBotMessage({ id: 'act', kind: 'agent_activity', role: 'assistant', content: '', createdAt: '2026-11-07T03:00:00.000Z', agentActivity: activity })!,
    normalizeBotMessage({ id: 'turn', kind: 'agent_turn', role: 'assistant', content: '', createdAt: '2026-11-07T03:00:00.000Z', rounds: [{ toolCalls: [{ name: 'read_file', input: { path: 'README.md' }, result: { ok: true } }] }] })!,
    normalizeBotMessage({ id: 'reply', kind: 'agent_reply', role: 'assistant', content: '正在写', createdAt: '2026-11-07T03:00:00.000Z', sources: ['session-a'] })!,
  ];
  const first = projectConversationRows(messages, null);
  assert.equal(first.projection, 'full');
  assert.deepEqual(first.rows, conversationRows(messages));
  const sourced = messages.slice();
  sourced[3] = { ...sourced[3]!, sources: ['session-b'] };
  const sourceChange = projectConversationRows(sourced, first);
  assert.equal(sourceChange.projection, 'full');
  assert.deepEqual(sourceChange.rows, conversationRows(sourced));
  const folded = messages.slice();
  folded[1] = { ...folded[1]!, agentActivity: { ...activity, state: 'reported' } };
  const foldChange = projectConversationRows(folded, first);
  assert.equal(foldChange.projection, 'full');
  assert.equal(foldChange.identityComparisons, 2);
  assert.deepEqual(foldChange.rows, conversationRows(folded));
  const middle = messages.slice();
  middle[2] = { ...middle[2]!, rounds: [{ text: '', toolCalls: [{ name: 'search_files', input: { query: '规则' }, result: { ok: true } }] }] };
  const toolChange = projectConversationRows(middle, first);
  assert.equal(toolChange.projection, 'full');
  assert.equal(toolChange.identityComparisons, 3);
  assert.deepEqual(toolChange.rows, conversationRows(middle));
});

test('a tail that changes projection inputs, or a copied prefix, scans again and keeps order', () => {
  const messages = history(8);
  const first = projectConversationRows(messages, null);
  assert.equal(first.projection, 'full');
  const copied = messages.map(message => ({ ...message }));
  const copiedProjection = projectConversationRows(copied, first);
  assert.equal(copiedProjection.projection, 'full');
  assert.deepEqual(copiedProjection.rows.map(row => row.type === 'message' ? row.message.id : row.id), first.rows.map(row => row.type === 'message' ? row.message.id : row.id));
  const sourced = messages.slice();
  const last = sourced[sourced.length - 1]!;
  sourced[sourced.length - 1] = { ...last, sources: ['session-b'] };
  const changed = projectConversationRows(sourced, first);
  assert.equal(changed.projection, 'full');
  assert.deepEqual(changed.rows, conversationRows(sourced));
  const appended = [...messages, normalizeBotMessage({ id: 'extra', kind: 'user_input', role: 'user', content: '还有', createdAt: '2026-11-07T03:00:00.000Z' })!];
  const extended = projectConversationRows(appended, first);
  assert.equal(extended.projection, 'full');
  assert.deepEqual(extended.rows.map(row => row.type === 'message' ? row.message.id : row.id), conversationRows(appended).map(row => row.type === 'message' ? row.message.id : row.id));
});

test('question acknowledgement does not copy messages whose cards stay unchanged', () => {
  const messages = history(6);
  assert.equal(hideAcknowledgedQuestions(messages), messages);
  assert.equal(hideAcknowledgedQuestions(messages)[1], messages[1]);
});
