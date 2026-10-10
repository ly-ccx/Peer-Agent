import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createProjectInbox } from './project-inbox.mjs';
import { createAgentCommunication, agentMessagesForContext } from './agent-communication.mjs';
import { createAgentEventPublisher } from './agent-activity.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createProjectAgentHost } from './runtime-host.mjs';
import { createGoalRunner } from '../goal-runner.mjs';
import { agentCommunicationExcludedPrefixes } from './work-session-profile.mjs';
import { createDelegationProvider } from './delegation-provider.mjs';
import { deriveSessionFacts, projectWorkSession } from '@peer-agent/protocol';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-agent-mail-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: path.join(root, 'conversations') });
  const parent = store.createConversation({ role: 'project_agent', workspaceId: 'ws', title: 'Bot' });
  const child = store.createConversation({ role: 'work_session', workspaceId: 'ws', title: '实现检查' });
  let plan = { planId: 'plan', title: '实现检查', conversationId: child.id, status: 'executing', runner: { status: 'running' },
    delegationOrigin: { workspaceId: 'ws', sessionId: 'worker', parentConversationId: parent.id, phase: 'running', readOnly: true } };
  let held = true, crash = false, resumed = 0, idle = Promise.resolve();
  const inbox = createProjectInbox({ rootDir: path.join(root, 'runtime'), mergeWindowMs: 10000 });
  const goals = { getPlan: () => plan, revisePlan(id, patch) { plan = { ...plan, ...patch }; return plan; } };
  const runner = { waitForIdle: () => idle, resume(id) { resumed += 1; plan.runner = { status: 'running' }; return {resumeAdmission: 'admitted'}; } };
  const options = { conversationStore: store, goalPlanStore: goals, goalRunner: runner,
    findSession: id => id === 'worker' ? plan : null, listSessions: () => [plan], canManageWorkspace: () => held,
    emitEvent: event => { if (crash) throw Error('inbox disk unavailable'); inbox.append('ws', [event]); } };
  const communication = createAgentCommunication(options);
  const sender = { role: 'work_session', agentKind: 'worker', workspaceId: 'ws', conversationId: child.id,
    sessionId: 'worker', planId: 'plan', deliveryKey: 'call1' };
  const bot = { role: 'project_agent', workspaceId: 'ws', conversationId: parent.id, deliveryKey: 'call2' };
  return { storeDir: path.join(root, 'conversations'), store, parent, child, communication, options, sender, bot, inbox, goals,
    get plan() { return plan; }, get resumed() { return resumed; },
    crash: value => { crash = value; }, lease: value => { held = value; }, idle: value => { idle = value; } };
}

test('independent conversations exchange durable facts without user messages or implicit resume', t => {
  const f = fixture(t);
  const sent = f.communication.send({ text: '读到两个实现入口', purpose: 'update' }, f.sender);
  assert.equal(sent.delivery, 'queued');
  const reply = f.communication.send({ sessionId: 'worker', text: '优先核对当前入口', purpose: 'update' }, f.bot);
  assert.equal(reply.ok, true);
  const rows = f.store.getPersistedConversationHistory(f.parent.id).messages;
  assert.equal(rows[0].kind, 'agent_message'); assert.equal(rows[0].role, 'system');
  assert.equal(rows[0].agentMessage.senderConversationId, f.child.id);
  assert.equal(f.inbox.takeBatch('ws').events[0].payload.agentMessage.messageId, sent.messageId);
  assert.equal(agentMessagesForContext(f.store.getConversation(f.child.id).messages, f.child.id)[0].text, '优先核对当前入口');
  assert.equal(f.resumed, 0);
});

test('identity, lease and closed-task gates reject before any persistent write', t => {
  const f = fixture(t), input = { text: '补充进展', purpose: 'update' };
  for (const context of [{ ...f.sender, workspaceId: 'other' }, { ...f.sender, conversationId: f.parent.id },
    { ...f.sender, agentKind: 'verifier' }, { ...f.sender, agentKind: 'explorer' }, { ...f.sender, planId: 'other' },
    { ...f.bot, conversationId: 'unrelated' }, { ...f.sender, role: 'chat' }]) {
    assert.equal(f.communication.send({ ...input, sessionId: 'worker' }, context).ok, false);
  }
  assert.equal(f.communication.send({ ...input, sessionId: 'other' }, f.sender).error, 'agent_identity_mismatch');
  f.lease(false); assert.equal(f.communication.send(input, f.sender).error, 'not_host'); f.lease(true);
  f.plan.status = 'cancelled'; assert.equal(f.communication.send(input, f.sender).error, 'session_not_running');
  assert.equal(f.store.getConversation(f.parent.id).messages.length, 0);
});

test('replay and restart repair write-before-Inbox failure without duplicate messages or events', t => {
  const f = fixture(t), input = { text: '回信不能丢', purpose: 'update' };
  f.crash(true); assert.throws(() => f.communication.send(input, f.sender), /disk/);
  assert.equal(f.store.getPersistedConversationHistory(f.parent.id).messages.length, 1);
  f.crash(false);
  const restartedStore = createConversationStore({ storeDir: f.storeDir });
  const restarted = createAgentCommunication({ ...f.options, conversationStore: restartedStore });
  restarted.recover(); restarted.recover();
  const result = restarted.send(input, f.sender);
  assert.equal(result.replayed, true);
  assert.equal(f.store.getPersistedConversationHistory(f.parent.id).messages.length, 1);
  assert.equal(f.inbox.takeBatch('ws').events.length, 1);
});

test('a parent question stops autonomous polling; only a correlated answer resumes after the safe boundary', async t => {
  const f = fixture(t);
  let release; f.idle(new Promise(resolve => { release = resolve; }));
  const question = f.communication.send({ text: '哪一个实现入口优先？', purpose: 'question' }, f.sender);
  assert.equal(question.waitingForParent, true);
  assert.equal(f.plan.delegationOrigin.agentWaitMessageId, question.messageId);
  assert.equal(f.communication.send({ sessionId: 'worker', text: '当前入口', purpose: 'answer' }, f.bot).error, 'agent_question_mismatch');
  assert.equal(f.communication.send({ sessionId: 'worker', text: '当前入口', purpose: 'answer', replyTo: question.messageId }, f.bot).ok, true);
  assert.equal(f.resumed, 0); assert.ok(f.plan.delegationOrigin.agentResumePending);
  release(); await f.communication.waitForResumes();
  assert.equal(f.resumed, 1); assert.equal(f.plan.delegationOrigin.agentWaitMessageId, null);
  const replay = f.communication.send({ text: '哪一个实现入口优先？', purpose: 'question' }, f.sender);
  assert.equal(replay.waitingForParent, undefined); assert.equal(f.plan.delegationOrigin.agentWaitMessageId, null);
});

test('resume cleanup preserves a newer worker question and its correlated parent answer', async t => {
  for (const immediateAnswer of [false, true]) {
    const f = fixture(t); let secondQuestion, resumed = 0;
    f.options.goalRunner.resume = () => {
      resumed++;
      if (resumed === 1) {
        secondQuestion = f.communication.send({purpose: 'question', text: '第二个入口如何处理？'}, {...f.sender, deliveryKey: 'next-question'});
        if (immediateAnswer) f.communication.send({sessionId: 'worker', purpose: 'answer', text: '按同样规则处理', replyTo: secondQuestion.messageId}, {...f.bot, deliveryKey: 'next-answer'});
      }
      return {resumeAdmission: 'admitted'};
    };
    const first = f.communication.send({purpose: 'question', text: '第一个入口如何处理？'}, f.sender);
    f.communication.send({sessionId: 'worker', purpose: 'answer', text: '核对当前实现', replyTo: first.messageId}, f.bot);
    await f.communication.waitForResumes();
    assert.equal(resumed, immediateAnswer ? 2 : 1);
    assert.equal(f.plan.delegationOrigin.agentWaitMessageId, immediateAnswer ? null : secondQuestion.messageId);
    assert.equal(f.plan.delegationOrigin.agentResumePending, null);
  }
});

test('a real human wait and a cancellation retain ownership when the parent answer arrives', async t => {
  for (const state of ['human', 'cancel']) {
    const f = fixture(t); let release; f.idle(new Promise(resolve => { release = resolve; }));
    const question = f.communication.send({ text: '入口？', purpose: 'question' }, f.sender);
    f.communication.send({ sessionId: 'worker', text: '当前入口', purpose: 'answer', replyTo: question.messageId }, f.bot);
    if (state === 'human') f.plan.runner.status = 'waiting_user'; else f.plan.status = 'cancelled';
    release(); await f.communication.waitForResumes();
    assert.equal(f.resumed, 0);
    assert.equal(Boolean(f.plan.delegationOrigin.agentResumePending), state === 'cancel');
    if (state === 'human') assert.equal(f.plan.runner.status, 'waiting_user');
  }
});

test('parent-answer reservation survives restart and resumes only the same live plan', async t => {
  const f = fixture(t);
  const question = f.communication.send({ text: '入口？', purpose: 'question' }, f.sender);
  f.lease(false);
  // A durable answer exists but coordination was interrupted before reserving a resume.
  f.store.appendMessage(f.child.id, { id: 'answer', role: 'system', kind: 'agent_message', content: '当前入口',
    agentMessage: { messageId: 'answer', workspaceId: 'ws', sessionId: 'worker', recipientConversationId: f.child.id,
      senderConversationId: f.parent.id, direction: 'parent_to_child', purpose: 'answer', replyTo: question.messageId, text: '当前入口' } });
  f.lease(true); const restarted = createAgentCommunication(f.options); restarted.recover();
  await restarted.waitForResumes(); assert.equal(f.resumed, 1);
});

test('the governed Provider returns PermissionGrant/Evidence and terminal control for a real worker question', async t => {
  const f = fixture(t);
  const provider = createDelegationProvider({ supervisor: { sendAgentMessage: f.communication.send } });
  const result = await provider.executeCapability({ call: { toolCallId: 'message-call', capabilityId: 'local.delegation.send_agent_message',
    arguments: { purpose: 'question', text: '先核对哪里？' } } }, {
    workspaceId: 'ws', conversationId: f.child.id, turnId: 'worker-turn', mode: 'goal', turnProfile: f.sender,
  });
  assert.equal(result.grant.granted, true); assert.ok(result.result.evidence);
  assert.equal(result.result.output.waitingForParent, true);
  assert.equal(result.result.outputPreview.control.reason, 'agent_message_wait');
});

test('host activity deduplicates lifecycle rows and never equates a returned report with verification', t => {
  const f = fixture(t), publish = createAgentEventPublisher({ inbox: f.inbox, conversationStore: f.store, findSession: () => f.plan });
  publish('ws', [{ eventId: 'start1', kind: 'session_started', sessionId: 'worker' }, { eventId: 'start2', kind: 'session_running', sessionId: 'worker' },
    { eventId: 'report', kind: 'report_available', sessionId: 'worker' }]);
  publish('ws', [{ eventId: 'report', kind: 'report_available', sessionId: 'worker' }]);
  const rows = f.store.getConversation(f.parent.id).messages.filter(row => row.kind === 'agent_activity');
  assert.deepEqual(rows.map(row => row.agentActivity.state), ['started', 'reported']);
  assert.equal(rows[0].agentActivity.name, '实现检查');
  assert.equal(deriveSessionFacts({ status: 'executing', runnerStatus: 'blocked', blockedReason: 'waiting_parent_agent' }).needsUser, false);
  const session = projectWorkSession({ planId: 'p', status: 'executing', runnerStatus: 'blocked', title: '检查', agentWaiting: true }, { sessionId: 'worker', origin: {} });
  assert.equal(session.status, 'waiting_agent'); assert.equal(session.nextAction, 'none'); assert.equal(session.actionRight, 'peer_advancing');
});

test('real GoalRunner parks a worker question and resumes the same plan with the durable answer', async t => {
  for (const scenario of ['normal', 'human', 'deferred']) {
  const f = fixture(t);
  const goals = createGoalPlanStore({storeDir: path.join(f.storeDir, '..', 'goals')});
  const selection = {modelProviderId: 'test-model', providerId: 'test', modelId: 'test', family: 'test'};
  const plan = goals.createPlan({conversationId: f.child.id, title: '实现检查', goal: '核查入口',
    tasks: [{taskId: 'inspect', title: 'Inspect', status: 'pending'}],
    delegationOrigin: {...f.plan.delegationOrigin, inputId: 'input', anchorMessageId: 'anchor',
      modelSelection: {worker: selection, explorer: selection, verifier: selection, resolvedAt: new Date().toISOString()}}});
  goals.promoteIntakeToGoal(plan.planId);
  let communication, calls = 0, question, ready = true;
  const runner = createGoalRunner({goalPlanStore: goals,
    prepareIsolation() { if (scenario === 'human' && goals.getPlan(plan.planId).delegationOrigin.agentResumePending) goals.markRequestedUserInput(plan.planId, {reason: 'human decision arrived at isolation boundary'}); },
    logger: {warn() {}}, maxTurns: 4, canRunPlan: () => ready,
    chatRuntime: {async runGoalTurn() {
      calls++;
      if (calls === 1) {
        question = communication.send({purpose: 'question', text: '先检查哪个入口？'}, {...f.sender, planId: plan.planId});
        assert.equal(question.waitingForParent, true);
        return {terminalStatus: 'done', toolCallCount: 1, awaitingParentAgent: true};
      }
      const mail = agentMessagesForContext(f.store.getPersistedConversationHistory(f.child.id).messages, f.child.id);
      assert.equal(mail.at(-1).replyTo, question.messageId);
      assert.equal(goals.getPlan(plan.planId).runner.intent, 'execute');
      return {terminalStatus: 'done', requestedUserInput: true, blockedReason: 'actual human decision', toolCallCount: 1};
    }}});
  communication = createAgentCommunication({...f.options, goalPlanStore: goals, goalRunner: runner,
    findSession: () => goals.getPlan(plan.planId), listSessions: () => [goals.getPlan(plan.planId)]});
  await runner.start(plan.planId, {awaitIdle: true});
  assert.equal(goals.getPlan(plan.planId).runner.blockedReason, 'waiting_parent_agent');
  await runner.start(plan.planId, {awaitIdle: true});
  assert.equal(calls, 1);
  if (scenario === 'deferred') ready = false;
  communication.send({sessionId: 'worker', purpose: 'answer', replyTo: question.messageId, text: '当前入口'}, f.bot);
  await communication.waitForResumes();
  if (scenario === 'deferred') {
    assert.equal(calls, 1);
    assert.equal(goals.getPlan(plan.planId).delegationOrigin.agentWaitMessageId, question.messageId);
    assert.ok(goals.getPlan(plan.planId).delegationOrigin.agentResumePending);
    ready = true;
    const restarted = createAgentCommunication({...f.options, goalPlanStore: goals, goalRunner: runner,
      findSession: () => goals.getPlan(plan.planId), listSessions: () => [goals.getPlan(plan.planId)]});
    restarted.recover(); await restarted.waitForResumes();
  }
  await runner.waitForIdle(plan.planId);
  assert.equal(calls, scenario === 'human' ? 1 : 2);
  assert.equal(goals.getPlan(plan.planId).runner.status, 'waiting_user');
  assert.equal(goals.getPlan(plan.planId).delegationOrigin.agentWaitMessageId, undefined);
  assert.equal(goals.listPlans().length, 1);
  assert.equal(goals.getPlan(plan.planId).delegationOrigin.agentResumePending, undefined);
  }
});

test('only main Bot and the fixed worker role project agent communication', () => {
  for (const profile of [{role: 'project_agent'}, {role: 'work_session', agentKind: 'worker'}])
    assert.deepEqual(agentCommunicationExcludedPrefixes(profile), []);
  for (const profile of [null, {role: 'chat'}, {role: 'goal_runner'}, {role: 'work_session', agentKind: 'explorer'}, {role: 'work_session', agentKind: 'verifier'}])
    assert.deepEqual(agentCommunicationExcludedPrefixes(profile), ['local.delegation.send_agent_message']);
});

test('a durable child message wakes the main Bot without a fabricated user input or repeated polling', async t => {
  const f = fixture(t); let calls = 0;
  const host = createProjectAgentHost({rootDir: path.join(f.storeDir, '..', 'host'), inbox: f.inbox,
    listWorkspaceIds: () => ['ws'], holdsLease: () => true, readLeaseEpoch: () => 'owner',
    resolveConversationId: () => f.parent.id,
    readMessages: id => f.store.getPersistedConversationHistory(id)?.messages ?? [],
    hasMessage: (id, messageId) => f.store.getPersistedConversationHistory(id)?.messages.some(row => row.id === messageId),
    appendMessage: (id, row) => f.store.appendMessage(id, row),
    resolveModel: () => ({ok: true, modelProviderId: 'scripted'}),
    executeTurn: async input => {
      calls++;
      assert.equal(input.turnProfile.role, 'project_agent');
      assert.equal(input.conversationId, f.parent.id);
      assert.deepEqual(input.plan.userInputs, []);
      const message = input.turnProfile.context.events.find(row => row.kind === 'agent_message').payload.agentMessage;
      assert.equal(message.senderConversationId, f.child.id);
      assert.equal(message.purpose, 'question');
      assert.equal(f.communication.send({sessionId: 'worker', purpose: 'answer', replyTo: message.messageId, text: '当前入口'}, f.bot).ok, true);
      return {terminalStatus: 'done', text: ''};
    }});
  t.after(() => host.dispose());
  f.communication.send({purpose: 'question', text: '入口？'}, f.sender);
  await host.sync(['ws']);
  await f.communication.waitForResumes();
  assert.equal(calls, 1); assert.equal(f.resumed, 1);
  await host.sync(['ws']); assert.equal(calls, 1);
  assert.equal(f.store.getPersistedConversationHistory(f.parent.id).messages.some(row => row.role === 'user'), false);
});
