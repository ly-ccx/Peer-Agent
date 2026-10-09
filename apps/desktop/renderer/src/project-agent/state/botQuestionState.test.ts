import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBotMessage, applyOptimistic } from './botConversationState.ts';
import { questionForInput, hideAcknowledgedQuestions } from './botQuestionState.ts';

const question = (id = 'r') => normalizeBotMessage({ id, kind: 'agent_reply', cards: [
  { cardId: `card:question:reply:${id}`, kind: 'question', resolvedState: 'open', content: '需要你回答' },
] })!;

test('手输回答只绑定最新对话问题，引用其它消息与任务/批准卡不自动回答', () => {
  assert.equal(questionForInput([question()], []), 'card:question:reply:r');
  assert.equal(questionForInput([question()], ['other', '旧消息']), undefined);
  const next = normalizeBotMessage({ id: 'next', kind: 'agent_reply' })!;
  assert.equal(questionForInput([question(), next], []), undefined);
  const task = normalizeBotMessage({ id: 'task', kind: 'system_card', cards: [{ cardId: 'card:question:s:q', kind: 'question' }] })!;
  assert.equal(questionForInput([task], []), undefined);
});

test('收到回答后收起对应选择；发送失败保留选择，重发绑定仍在', () => {
  const input = { inputId: 'a', text: '自己填写的回答', quoteRefs: [], createdAt: 'now', answerTo: 'card:question:reply:r', state: 'received' as const };
  const shown = applyOptimistic([question()], [input]);
  assert.equal(shown[1]?.answerTo, input.answerTo);
  assert.equal(hideAcknowledgedQuestions(shown)[0]?.cards[0]?.resolvedState, 'resolved');
  assert.equal(hideAcknowledgedQuestions(shown)[0]?.cards[0]?.cardId, input.answerTo);
  const failed = applyOptimistic([question()], [{ ...input, state: 'failed' }]);
  assert.equal(hideAcknowledgedQuestions(failed)[0]?.cards.length, 1);
  assert.equal(hideAcknowledgedQuestions(failed)[0]?.cards[0]?.resolvedState, 'open');
  const sending = applyOptimistic([question()], [{ ...input, state: 'sending' }]);
  assert.equal(hideAcknowledgedQuestions(sending)[0]?.cards[0]?.resolvedState, 'open');
  assert.equal(failed[1]?.answerTo, input.answerTo);
});
