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
