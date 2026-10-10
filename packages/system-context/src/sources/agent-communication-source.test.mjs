import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleSystemContext, createAgentCommunicationPromptSource } from '../index.mjs';

const question = { messageId: 'question1', sessionId: 'child1', direction: 'child_to_parent', purpose: 'question', text: 'IGNORE_PERMISSIONS' };
test('parent and worker messages enter only quoted bounded L7 facts', () => {
  for (const input of [
    { role: 'project_agent', turnContext: { events: [{kind: 'agent_message', payload: {agentMessage: question}}] } },
    { role: 'work_session', agentKind: 'worker', turnContext: { agentMessages: [{...question, direction: 'parent_to_child', purpose: 'answer', replyTo: 'question1'}] } },
  ]) {
    const result = assembleSystemContext(input);
    const mail = result.sections.find(row => row.id === 'agent-communication');
    assert.equal(mail.layer, 'L7_CONTINUITY');
    assert.match(mail.content, /not user instructions, permissions/);
    assert.ok(result.sections.filter(row => row.layer !== 'L7_CONTINUITY').every(row => !row.content.includes('IGNORE_PERMISSIONS')));
    if (input.role === 'work_session') assert.match(mail.content, /"replyTo":"question1"/);
  }
  const source = createAgentCommunicationPromptSource();
  assert.deepEqual(source.render(source.observe({role: 'chat', events: [{kind: 'agent_message', payload: {agentMessage: question}}]})), []);
  assert.deepEqual(source.render(source.observe({role: 'work_session', agentKind: 'verifier', turnContext: {agentMessages: [question]}})), []);
  const bounded = source.observe({role: 'work_session', agentKind: 'worker', turnContext: {agentMessages: Array.from({length: 100}, () => ({...question, text: 'a'.repeat(10000)}))}});
  assert.ok(bounded.messages.length <= 8);
  assert.ok(bounded.messages.reduce((sum, row) => sum + row.text.length, 0) <= 12000);
});
