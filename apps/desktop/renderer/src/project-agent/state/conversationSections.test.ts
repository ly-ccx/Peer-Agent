import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeConversationCards, statusAfterRefreshFailure } from './conversationSections.ts';
import { normalizeBotMessage } from './botConversationState.ts';
import { questionForInput } from './botQuestionState.ts';

test('card availability cannot replace public messages or turn a refresh failure into an empty conversation', () => {
  const messages = [normalizeBotMessage({ id: 'reply', kind: 'agent_reply', content: '结果已返回', role: 'assistant' })!];
  const enriched = mergeConversationCards(messages, [{ cardId: 'question', kind: 'question', refs: { replyMessageId: 'reply' }, content: '选择' }]);
  assert.equal(enriched[0].content, '结果已返回'); assert.equal(enriched[0].cards[0].cardId, 'question');
  assert.equal(mergeConversationCards(messages, [])[0].content, '结果已返回');
  assert.equal(statusAfterRefreshFailure('ready'), 'ready'); assert.equal(statusAfterRefreshFailure('loading'), 'error');
});

test('an independently loaded conversational question binds a freeform answer through the same public projection', () => {
  const messages = [normalizeBotMessage({ id: 'reply', kind: 'agent_reply', content: '你指哪份记录？', role: 'assistant' })!];
  const question = { cardId: 'card:question:reply:reply', kind: 'question', refs: { replyMessageId: 'reply' }, content: '选择记录' };
  const visible = mergeConversationCards(messages, [question]);
  assert.equal(questionForInput(visible, []), question.cardId);
  assert.equal(questionForInput(visible, ['another-reply']), undefined);
  assert.equal(questionForInput(mergeConversationCards(messages, [{ ...question, resolvedState: 'resolved' }]), []), undefined);
  assert.equal(questionForInput(mergeConversationCards(messages, []), []), undefined);
});

test('historical failures outside the loaded page cannot appear after a new successful reply', () => {
  const messages = [normalizeBotMessage({ id: 'new-reply', kind: 'agent_reply', turnId: 'new-turn', content: '已收下。' })!];
  const cards = [
    { cardId: 'old-error', kind: 'agent_unavailable', content: 'HTTP 400', refs: { turnId: 'old-turn' }, resolvedState: 'open' },
    { cardId: 'old-stop', kind: 'agent_stopped', content: '已停止', refs: { turnId: 'stopped-turn' }, resolvedState: 'open' },
    { cardId: 'approval', kind: 'approval', content: '需要批准', resolvedState: 'open' },
  ];
  const before = JSON.stringify(cards);
  const visible = mergeConversationCards(messages, cards);
  assert.deepEqual(visible.map(message => message.id), ['new-reply', 'approval']);
  assert.deepEqual(visible[0].cards, []);
  assert.equal(JSON.stringify(cards), before, 'presentation cannot mark historical failures recovered');
});

test('loading the failed attempt keeps its error and current recovery action at the original position', () => {
  const failure = normalizeBotMessage({ id: 'failed-message', kind: 'system_card', turnId: 'old-turn',
    createdAt: '2026-10-06T04:15:38Z', content: 'Original HTTP 400' })!;
  const reply = normalizeBotMessage({ id: 'reply', kind: 'agent_reply', turnId: 'new-turn', content: '已收下。' })!;
  const card = { cardId: 'old-error', kind: 'agent_unavailable', content: 'Original HTTP 400', refs: { turnId: 'old-turn' },
    recoveryAction: { canContinue: false, blockedReason: 'STALE_TURN' } };
  const visible = mergeConversationCards([failure, reply], [card]);
  assert.deepEqual(visible.map(message => message.id), ['failed-message', 'reply']);
  assert.equal(visible[0].content, 'Original HTTP 400');
  assert.equal(visible[0].createdAt, failure.createdAt);
  assert.equal(visible[0].cards[0].cardId, 'old-error');
  assert.deepEqual(visible[0].cards[0].recoveryAction, card.recoveryAction);
  assert.deepEqual(visible[1].cards, []);
  assert.equal(mergeConversationCards(visible, [card])[0].cards.length, 1);
});

test('a current failure remains visible without attaching it to a delivered reply from the same turn', () => {
  const reply = normalizeBotMessage({ id: 'reply', kind: 'agent_reply', turnId: 'current', content: '部分进展' })!;
  const failure = normalizeBotMessage({ id: 'failure', kind: 'system_card', turnId: 'current', cards: [
    { cardId: 'error', kind: 'agent_unavailable', content: 'Connection failed' },
  ] })!;
  const card = { cardId: 'error', kind: 'agent_unavailable', content: 'Connection failed', refs: { turnId: 'current' },
    recoveryAction: { canContinue: true } };
  const visible = mergeConversationCards([reply, failure], [card]);
  assert.deepEqual(visible.map(message => message.id), ['reply', 'failure']);
  assert.deepEqual(visible[0].cards, []);
  assert.deepEqual(visible[1].cards[0].recoveryAction, { canContinue: true });
});
