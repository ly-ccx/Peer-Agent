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
  assert.equal(hideAcknowledgedQuestions(shown)[0]?.cards.length, 0);
  const failed = applyOptimistic([question()], [{ ...input, state: 'failed' }]);
  assert.equal(hideAcknowledgedQuestions(failed)[0]?.cards.length, 1);
  assert.equal(failed[1]?.answerTo, input.answerTo);
});

test('继续提问在持久回执后收起旧对话选项，失败或发送中保留；任务问题不自动关闭', () => {
  const task = normalizeBotMessage({ id: 'task', kind: 'system_card', cards: [
    { cardId: 'card:question:task:q', kind: 'question', resolvedState: 'open' },
    { cardId: 'card:approval:a', kind: 'approval', resolvedState: 'open' },
    { cardId: 'card:confirm_result:s', kind: 'confirm_result', resolvedState: 'open' },
  ] })!;
  const later = normalizeBotMessage({ id: 'later', kind: 'agent_reply', content: '补充说明' })!;
  const input = { inputId: 'followup', text: '先问另一个问题', quoteRefs: ['other'], createdAt: 'now', state: 'received' as const };
  for (const state of ['sending', 'failed', 'received'] as const) {
    const shown = hideAcknowledgedQuestions(applyOptimistic([question(), task, later], [{ ...input, state }]));
    assert.equal(shown[0]?.cards.length, state === 'received' ? 0 : 1);
    assert.equal(shown[1]?.cards.length, 3);
    assert.equal(shown[0]?.content, question().content);
  }
  const newQuestion = question('new');
  const shown = hideAcknowledgedQuestions([...applyOptimistic([question()], [input]), newQuestion]);
  assert.equal(shown[0]?.cards.length, 0);
  assert.equal(shown.at(-1)?.cards.length, 1);
});
