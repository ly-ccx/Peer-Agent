import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { projectReplyQuestions } from './question-lifecycle.mjs';
import { projectBotAttention } from './attention.mjs';
import { projectCards } from './card-projection.mjs';
const profile = { workspaceId: 'w', displayName: 'Peer RSI' };
const question = (id, extra = {}) => ({ id, kind: 'agent_reply', content: `Question ${id}`, question: { options: ['A', 'B'], ...extra } });
const answer = id => ({ id: `answer-${id}`, kind: 'user_input', answerTo: `card:question:reply:${id}`, content: 'A' });
const project = extra => projectBotAttention({ profile, ...extra });

test('actual actionable child questions count once alongside a parent decision; resolved and terminal tasks stay out', () => {
  const cards = projectCards('w', { questions: [
    { sessionId: 'child', questionId: 'q', prompt: 'Choose the output', options: ['CSV', 'JSON'] },
    { sessionId: 'done', questionId: 'q', answered: true },
    { sessionId: 'cancelled', questionId: 'q' },
  ] });
  const sessions = [{ sessionId: 'child', status: 'waiting_user' }, { sessionId: 'cancelled', status: 'cancelled' }];
  const items = project({ messages: [question('parent')], sessions, cards: [...cards, cards[0]] });
  assert.deepEqual(items.map(i => i.id).sort(), ['card:question:child:q', 'card:question:reply:parent']);
  assert.equal(items.find(i => i.sessionId === 'child').card.actions[0].payload.answerTo, 'card:question:child:q');
  assert.equal(project({ sessions, cards: cards.map(c => ({ ...c, actions: [] })) }).length, 0);
});

test('screenshot history: three old questions and a waiting child produce zero after latest answer; new question produces one', () => {
  const messages = [question('old-1'), question('old-2'), question('old-3'), question('latest'), answer('latest')];
  const sessions = [{ sessionId: 'child', status: 'waiting_user', title: '焦点高亮' }];
  assert.equal(project({ messages, sessions }).length, 0);
  messages.push(question('now'));
  assert.deepEqual(project({ messages, sessions }).map(i => i.messageId), ['now']);
  assert.equal(project({ messages: structuredClone(messages), sessions: structuredClone(sessions) }).length, 1);
});
test('moving on retires conversational attention without granting permission or choosing an option', () => {
  const q = question('q');
  const messages = [q, { kind: 'agent_turn' }, { kind: 'agent_activity' }];
  assert.equal(project({ messages }).length, 1);
  for (const input of [
    { kind: 'user_input', quoteRefs: ['other'] },
    { kind: 'user_input', answerTo: 'card:question:task:q' },
    { role: 'user', content: 'my new topic', quoteRefs: ['other'] },
  ]) {
    const continued = [...messages, input];
    assert.equal(project({ messages: continued }).length, 0);
    assert.equal(projectReplyQuestions(continued).get('q').state, 'superseded');
    assert.equal(q.question.answered, undefined);
    assert.equal(project({ messages: continued, approvals: [{ approvalId: 'p', state: 'open' }] })[0].kind, 'approval');
  }
  for (const pending of ['sending', 'failed', 'unknown']) {
    assert.equal(project({ messages: [...messages, { kind: 'user_input', quoteRefs: ['other'], pending }] }).length, 1);
    assert.equal(project({ messages: [...messages, { ...answer('q'), pending }] }).length, 1);
  }
  assert.equal(project({ messages: [...messages, answer('q')] }).length, 0);
  assert.equal(projectReplyQuestions([...messages, answer('q')]).get('q').state, 'answered');
  assert.equal(project({ messages: [q, { kind: 'user_input', content: 'my answer' }] }).length, 0);
});
test('replacement and explicit deadline are reconstructible and do not revive older prompts', () => {
  const messages = [question('first'), question('expired', { expiresAt: '2026-10-20T01:00:00Z' })];
  const now = Date.parse('2026-10-20T02:00:00Z');
  assert.deepEqual([...projectReplyQuestions(messages, now).values()].map(v => v.state), ['superseded', 'expired']);
  assert.equal(project({ messages, now }).length, 0);
  assert.equal(project({ messages: [question('very-old')], now }).length, 1, 'age alone never consents or silently expires a decision');
});
test('only current human permissions and confirmations count, task state alone does not', () => {
  const approvals = [{ approvalId: 'live', sessionId: 'result', state: 'open' }, { approvalId: 'live', sessionId: 'result', state: 'open' },
    { approvalId: 'old', state: 'approved' }, { approvalId: 'expired', state: 'open', deadlineAt: '2000-01-01' }];
  const sessions = [{ sessionId: 'result', status: 'result_ready', title: 'result' }, { sessionId: 'child', status: 'waiting_user' },
    { sessionId: 'cancelled', status: 'cancelled' }];
  const confirmations = [{ sessionId: 'result' }, { sessionId: 'cancelled' }];
  assert.deepEqual(project({ approvals, sessions, confirmations }).map(i => i.id), ['card:approval:live']);
  assert.equal(project({ sessions }).length, 0, 'auto acceptance remains bot-owned');
  assert.equal(project({ sessions: [{ sessionId: 'requested', title: 'Explicit user review', status: 'result_ready', resultConfirmationRequired: true }] }).length, 1);
  assert.equal(projectBotAttention({ profile: { ...profile, acceptancePolicy: 'confirm' }, sessions: [{ sessionId: 'blocked', status: 'result_ready', resultConfirmationRequired: false }] }).length, 0);

  assert.equal(projectBotAttention({ profile: { ...profile, acceptancePolicy: 'confirm' }, sessions }).length, 1);
  assert.equal(project({ sessions: [{ sessionId: 'manual', title: 'Review actual report', completionReviewRequired: true }] })[0].card, undefined,
    'manual DoD must open the full report, never a summary-only confirmation');
});
test('linear projection on large user-scale history keeps only the latest actual decision', () => {
  const messages = Array.from({ length: 20000 }, (_, i) => i % 2 ? { kind: 'agent_turn', rounds: [] } : question(`q-${i}`));
  const start = performance.now();
  const items = project({ messages });
  assert.equal(items.length, 1); assert.equal(items[0].messageId, 'q-19998');
  assert.ok(performance.now() - start < 500, '20k-message attention scan stays bounded');
});
