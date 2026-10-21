import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createBotDirectory } from '../../../../../packages/runtime-node/src/project-agent/bot-directory.mjs';
import { createInputQueue } from '../../../../../packages/runtime-node/src/project-agent/input-queue.mjs';
import { createProjectAgentApplicationService } from './project-agent-application-service.mjs';
import { createDesktopProjectFacts } from './project-facts.mjs';
const question = id => ({ id, role: 'assistant', kind: 'agent_reply', content: `Decision ${id}`, question: { options: ['A', 'B'] } });
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-attention-flow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const messages = [question('old'), question('current')];
  const profile = { workspaceId: 'w', displayName: 'Peer', agentConversationId: 'bot', status: 'active', avatar: { kind: 'generated' } };
  mkdirSync(path.join(root, 'projects', 'w'), { recursive: true });
  writeFileSync(path.join(root, 'projects', 'w', 'profile.json'), JSON.stringify(profile));
  const directory = createBotDirectory({ rootDir: root, readMessages: () => messages,
    listSessions: () => [{ sessionId: 'child', status: 'waiting_user', title: 'Bot follows up' }] });
  const queue = createInputQueue({ rootDir: path.join(root, 'project-runtime'), resolveConversationId: () => 'bot',
    hasMessage: (_, id) => messages.some(m => m.id === id), appendMessage: (_, message) => messages.push(message) });
  let wakes = 0;
  const service = createProjectAgentApplicationService({ enabled: () => true, directory, inputQueue: queue, wake: () => { wakes++; },
    sessions: {}, schedule: () => 1 });
  return { root, messages, directory, queue, service, wakes: () => wakes };
}
test('actual directory, application service and durable queue: detail/count, rejected old answer, exactly-once answer, restart', async t => {
  const f = fixture(t);
  assert.equal(f.directory.list()[0].state.needsYou, 1);
  assert.deepEqual(f.service.listAttention().items.map(i => i.messageId), ['current']);
  assert.equal(f.service.listAttention({ workspaceId: 'unknown' }).code, 'NOT_FOUND');
  const old = await f.service.submitInput({ workspaceId: 'w', inputId: 'late', text: 'A', answerTo: 'card:question:reply:old' });
  assert.equal(old.code, 'QUESTION_CLOSED'); assert.equal(f.wakes(), 0);
  const input = { workspaceId: 'w', inputId: 'answer', text: 'A', answerTo: 'card:question:reply:current' };
  assert.equal((await f.service.submitInput(input)).ok, true);
  assert.equal((await f.service.submitInput({ ...input, inputId: 'duplicate-click' })).code, 'QUESTION_CLOSED');
  assert.equal((await f.service.submitInput(input)).ok, true); assert.equal(f.wakes(), 1);
  f.queue.consume('w');
  assert.equal(f.messages.filter(m => m.inputId === 'answer').length, 1);
  assert.equal(f.service.listAttention().items.length, 0); assert.equal(f.directory.list()[0].state.needsYou, 0);
  f.messages.push(question('next'));
  assert.equal(f.service.listAttention().items.length, 1);
  assert.equal(f.directory.questionState('w', 'old'), 'superseded');
  const restarted = createBotDirectory({ rootDir: f.root, readMessages: () => structuredClone(f.messages) });
  assert.deepEqual(restarted.attention().map(i => i.id), f.directory.attention().map(i => i.id));
});
test('disabled host and failed queue cannot close a current question', async t => {
  const f = fixture(t);
  const disabled = createProjectAgentApplicationService({ directory: f.directory });
  assert.equal(disabled.listAttention().code, 'PROJECT_AGENT_DISABLED');
  const fail = createProjectAgentApplicationService({ enabled: () => true, directory: f.directory,
    inputQueue: { submitInput() { throw Error('disk full'); } }, schedule: () => 1 });
  assert.equal((await fail.submitInput({ workspaceId: 'w', inputId: 'retry', text: 'A', answerTo: 'card:question:reply:current' })).ok, false);
  assert.equal(f.service.listAttention().items.length, 1);
});

test('canonical child request appears in count/detail and its queued answer clears attention without changing the task', async t => {
  const f = fixture(t);
  const session = { sessionId: 'child', conversationId: 'child-history', status: 'waiting_user', title: 'Choose format' };
  const facts = createDesktopProjectFacts({ runtimeRoot: path.join(f.root, 'project-runtime'),
    supervisor: { sessionsForProject: () => [session] }, profileStore: { read: () => ({ agentConversationId: 'bot' }) },
    conversationStore: { getPersistedConversationHistory: id => ({ messages: id === 'bot' ? f.messages : [
      { id: 'tool-message', segments: [{ tool: 'request_user_input', toolCallId: 'format', args: { question: 'Choose format', options: ['CSV', 'JSON'] } }] },
    ] }) } });
  const directory = createBotDirectory({ rootDir: f.root, readMessages: () => f.messages,
    listSessions: () => [session], readQuestionCards: workspaceId => facts.questionCards(workspaceId) });
  const service = createProjectAgentApplicationService({ enabled: () => true, directory, inputQueue: f.queue,
    wake: () => {}, schedule: () => 1 });
  assert.equal(directory.list()[0].state.needsYou, 2);
  const child = service.listAttention().items.find(item => item.sessionId === 'child');
  assert.equal(child.card.actions[0].payload.text, 'CSV');
  assert.equal((await service.submitInput({ workspaceId: 'w', inputId: 'child-answer', ...child.card.actions[0].payload })).ok, true);
  f.queue.consume('w');
  assert.equal(service.listAttention().items.some(item => item.sessionId === 'child'), false);
  assert.equal(directory.list()[0].state.needsYou, 1, 'parent question remains open');
  assert.equal(session.status, 'waiting_user', 'a reply receipt is not a task terminal');
});

test('a summary read at the deadline cannot consume the refresh owed to an open attention sheet', t => {
  const f = fixture(t);
  let at = 0;
  const timers = [], events = [];
  f.messages.splice(0, f.messages.length, { ...question('deadline'),
    question: { options: ['A'], expiresAt: new Date(100).toISOString() } });
  const directory = createBotDirectory({ rootDir: f.root, readMessages: () => f.messages,
    now: () => new Date(at).toISOString() });
  const service = createProjectAgentApplicationService({ enabled: () => true, directory,
    now: () => new Date(at).toISOString(),
    schedule: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    broadcast: (channel, payload) => events.push({ channel, payload }) });
  t.after(() => service.dispose());
  assert.equal(service.listAttention({ workspaceId: 'w' }).items.length, 1);
  // A list refresh may run before an already-due timer gets its turn on the main loop.
  at = 100;
  assert.equal(service.get({ workspaceId: 'w' }).item.state.needsYou, 0);
  const refreshTimers = timers.filter(timer => timer !== timers[0]);
  for (const timer of refreshTimers) timer.fn();
  assert.deepEqual(events, [
    { channel: 'project-agent:changed', payload: { workspaceIds: ['w'] } },
    { channel: 'project-agent:conversation-changed', payload: { workspaceIds: ['w'] } },
  ]);
  assert.equal(service.listAttention({ workspaceId: 'w' }).items.length, 0);
  timers[0].fn();
  assert.equal(timers.length, 3, 'the stale timer cannot publish a duplicate expiry');
});
