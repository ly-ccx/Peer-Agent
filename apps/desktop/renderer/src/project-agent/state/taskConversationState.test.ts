import test from 'node:test';
import assert from 'node:assert/strict';
import { taskConversationContext } from './taskConversationState.ts';
import { normalizeBotMessage } from './botConversationState.ts';
import { indexBotWork } from './botWorkState.ts';
import { readDrawerSession } from './drawerState.ts';

const work = indexBotWork([readDrawerSession({ sessionId: 'task', origin: { anchorMessageId: 'input' } })!], true);
const message = (id: string, extra = {}) => normalizeBotMessage({ id, kind: 'agent_reply', role: 'assistant', content: 'Current note', createdAt: '2026-10-06T08:00:00Z', ...extra })!;
test('the latest host-associated bot note is used, excluding prose claims and internal turns', () => {
  const rows = [message('old', { sources: ['task'] }), message('new', { replyTo: ['input'] }),
    message('unrelated', { content: 'I am working on task' }), message('internal', { kind: 'agent_turn', sources: ['task'] })];
  assert.equal(taskConversationContext('workspace', 'task', rows, work)?.messageId, 'new');
  assert.equal(taskConversationContext('workspace', 'other', rows, work), null);
  assert.equal(taskConversationContext('workspace', null, rows, work), null);
});
test('a real unanswered question remains the destination even after another status note', () => {
  const question = { cardId: 'question', kind: 'question', content: 'Which source should I use?', resolvedState: 'open',
    actions: [{ id: 'answer', payload: { text: 'Current files' } }] };
  const context = taskConversationContext('workspace', 'task', [message('ask', { sources: ['task'], cards: [question] }), message('note', { sources: ['task'] })], work)!;
  assert.equal(context.messageId, 'ask');
  assert.equal(context.question?.content, question.content);
  assert.equal(context.workspaceId, 'workspace');
});
test('resolved questions and cards without an answer action never become a new decision', () => {
  const rows = [message('done', { sources: ['task'], cards: [{ cardId: 'q', kind: 'question', content: 'Old', resolvedState: 'resolved', actions: [{ id: 'answer' }] }] }),
    message('latest', { sources: ['task'], cards: [{ cardId: 'no-action', kind: 'question', content: 'Not actionable' }] })];
  const context = taskConversationContext('workspace', 'task', rows, work)!;
  assert.equal(context.question, null); assert.equal(context.messageId, 'latest');
});
test('a system question is associated only by its structured session reference', () => {
  const context = taskConversationContext('workspace', 'task', [message('system', { kind: 'system_card', cards: [{ cardId: 'q', kind: 'question', content: 'Confirm scope?', refs: { sessionId: 'task' },
    actions: [{ id: 'answer', payload: { text: 'Continue', answerTo: 'card:question:task:q' } }] }] })], work)!;
  assert.equal(context.messageId, 'system'); assert.equal(context.question?.cardId, 'q');
});
test('a reply mentioning this task never borrows another task’s question', () => {
  const rows = [message('mixed', { sources: ['task'], cards: [{ cardId: 'q', kind: 'question', content: 'Approve another task?', refs: { sessionId: 'other' }, actions: [{ id: 'answer' }] }] })];
  assert.equal(taskConversationContext('workspace', 'task', rows, work)?.question, null);
});
