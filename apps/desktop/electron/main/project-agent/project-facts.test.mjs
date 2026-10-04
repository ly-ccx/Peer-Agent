import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopProjectFacts } from './project-facts.mjs';

test('RC5 已保存的手输回答关闭对话选择，而引用其它消息和任务批准不会被推断', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-reply-question-'));
  const messages = [{ id: 'r', kind: 'agent_reply', question: { options: ['A', 'B'] } }];
  try {
    const facts = createDesktopProjectFacts({ runtimeRoot: root,
      supervisor: { sessionsForProject: () => [], acceptance: () => null }, approvalStore: { list: () => [{ approvalId: 'permission', state: 'open' }] },
      profileStore: { read: () => ({ agentConversationId: 'parent' }) },
      conversationStore: { getPersistedConversationHistory: () => ({ messages }) } });
    const question = () => facts.cards('w').find(card => card.cardId === 'card:question:reply:r');
    assert.equal(question().resolvedState, 'open');
    messages.push({ kind: 'user_input', content: '手输答案', quoteRefs: ['other', '其它消息'] });
    assert.equal(question().resolvedState, 'open');
    messages.pop(); messages.push({ kind: 'user_input', content: '手输答案' });
    assert.equal(question().resolvedState, 'resolved');
    assert.equal(facts.cards('w').find(card => card.kind === 'approval').resolvedState, 'open');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a started-task reply does not count as delivery of its completed result', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-delivery-facts-'));
  let status = 'running';
  try {
    const facts = createDesktopProjectFacts({
      runtimeRoot: root,
      supervisor: {
        sessionsForProject: () => [{ sessionId: 's1', status: 'result_ready',
          origin: { anchorMessageId: 'input-1' } }],
        acceptance: () => null,
      },
      profileStore: { read: () => ({ agentConversationId: 'parent' }) },
      conversationStore: { getPersistedConversationHistory: () => ({ messages: [{
        kind: 'agent_reply', sources: ['s1'], meta: { sessionStates: [{ sessionId: 's1', status }] },
      }] }) },
    });
    assert.deepEqual(facts.delivery('w1').unreportedResults, [{ sessionId: 's1', anchorMessageId: 'input-1' }]);
    status = 'result_ready';
    assert.deepEqual(facts.delivery('w1').unreportedResults, []);
    status = 'accepted';
    assert.deepEqual(facts.delivery('w1').unreportedResults, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('failed dependency facts produce a stable decision card without a fabricated tool call', () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'b4-dependency-card-'));
  let status='waiting_user';const messages=[];
  try {
    const facts=createDesktopProjectFacts({runtimeRoot:root,
      supervisor:{sessionsForProject:()=>[{sessionId:'child',title:'后续任务',status,queueReason:'dependency_failed',queuedBehind:[{sessionId:'dep',title:'前置任务'}]}],acceptance:()=>null},
      approvalStore:{list:()=>[]},profileStore:{read:()=>({agentConversationId:'parent'})},
      conversationStore:{getPersistedConversationHistory:()=>({messages})}});
    const first=facts.cards('w');assert.equal(first.length,1);
    assert.equal(first[0].cardId,'card:question:child:dependency');
    assert.match(first[0].content,/未成功签收/);assert.equal(first[0].kind,'question');
    assert.equal(first[0].resolvedState,'open');assert.equal(first[0].actions.length,2);
    assert.deepEqual(facts.cards('w'),first);
    messages.push({role:'user',answerTo:first[0].cardId,content:'重新安排任务'});
    assert.equal(facts.cards('w')[0].resolvedState,'resolved');
    assert.equal(status,'waiting_user'); // Answering does not change dependency admission.
    status='cancelled';assert.equal(facts.cards('w').length,0);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('later actual turns retire stale unavailable actions while assistant claims cannot resolve them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'b4-stale-error-card-'));
  const messages = [{ id: 'a', role: 'assistant', kind: 'system_card', card: 'agent_unavailable', turnId: 't1', content: '代理暂时不可用：离线' }];
  try {
    const facts = createDesktopProjectFacts({ runtimeRoot: root,
      supervisor: { sessionsForProject: () => [], acceptance: () => null }, approvalStore: { list: () => [] },
      profileStore: { read: () => ({ agentConversationId: 'parent' }) },
      conversationStore: { getPersistedConversationHistory: () => ({ messages }) } });
    messages.push({ role: 'assistant', content: '已经恢复了' });
    assert.equal(facts.cards('w')[0].resolvedState, 'open');
    messages.push({ id: 't2', role: 'assistant', kind: 'agent_turn' },
      { id: 'b', role: 'assistant', kind: 'system_card', card: 'agent_unavailable', turnId: 't2', content: '代理暂时不可用：仍离线' });
    const cards = facts.cards('w');
    assert.equal(cards.find(card => card.refs.turnId === 't1').resolvedState, 'resolved');
    assert.deepEqual(cards.find(card => card.refs.turnId === 't1').actions, []);
    assert.equal(cards.find(card => card.refs.turnId === 't2').resolvedState, 'open');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
