import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { takeoverHumanBlocker } from './session-takeover.mjs';
import { reduceAgentSupervision } from './agent-supervision-state.mjs';
import { reduceCoordination } from './work-coordination.mjs';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createAgentDelivery, agentDelivery } from './agent-delivery.mjs';
import { agentMessagesForContext } from './agent-communication.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { createSupervisedCommunication } from './agent-supervision-communication.mjs';

const command = (id = 'q', direction = 'child_to_parent') => ({ messageId: id, operationId: id, workspaceId: 'w', workId: 'work',
  sessionId: 'child', goalRevision: 1, executionEpoch: 'epoch', payloadHash: id, direction,
  recipientConversationId: direction === 'child_to_parent' ? 'parent' : 'child-conversation', deliveryIntent: 'ensure_turn', text: 'Choose', purpose: 'question' });
const receipt = message => ({ operationId: message.operationId, messageId: message.messageId, sessionId: message.sessionId,
  goalRevision: message.goalRevision, executionEpoch: message.executionEpoch, delivery: 'queued', admission: 'pending', effect: 'pending' });
const request = { requestId: 'q', revision: 1, sessionId: 'child', workId: 'work', parentConversationId: 'parent', goalRevision: 1,
  question: 'Choose', allowText: false, options: [{ optionId: 'one', label: 'One' }], responder: 'parent', status: 'open' };
function committed() { const message = command(); return reduceAgentSupervision({}, { kind: 'agent_message_committed', revision: 1, message, receipt: receipt(message), request }); }

test('delivery, admission and effect remain distinct; stale epochs cannot alter receipts', () => {
  let state = committed();
  assert.throws(() => reduceAgentSupervision(state, { kind: 'agent_command_updated', operationId: 'q', goalRevision: 1, executionEpoch: 'old', patch: { admission: 'admitted' } }), /agent_command_stale/);
  assert.throws(() => reduceAgentSupervision(state, { kind: 'agent_command_updated', operationId: 'q', goalRevision: 1, executionEpoch: 'epoch', patch: { effect: 'applied', admission: 'admitted', attemptRef: 'turn' } }), /agent_effect_unproven/);
  state = reduceAgentSupervision(state, { kind: 'agent_context_observed', conversationId: 'parent', messageIds: ['q'], at: 'now' });
  assert.equal(state.agentCommands.q.admission, 'pending');
  state = reduceAgentSupervision(state, { kind: 'agent_command_updated', operationId: 'q', goalRevision: 1, executionEpoch: 'epoch', patch: { effect: 'applied', admission: 'admitted', attemptRef: 'turn' } });
  state = reduceAgentSupervision(state, { kind: 'agent_command_updated', operationId: 'q', goalRevision: 1, executionEpoch: 'epoch', patch: { effect: 'pending', delivery: 'queued' } });
  assert.equal(state.agentCommands.q.effect, 'applied');
  assert.equal(state.agentCommands.q.delivery, 'observed');
});

test('observation cannot acknowledge another recipient and malformed states fail closed', () => {
  const state = committed();
  assert.throws(() => reduceAgentSupervision(state, { kind: 'agent_context_observed', conversationId: 'other', messageIds: ['q'] }), /out_of_scope/);
  assert.throws(() => reduceAgentSupervision(state, { kind: 'agent_command_updated', operationId: 'q', goalRevision: 1, executionEpoch: 'epoch', patch: { admission: 'success' } }), /patch_invalid/);
});

test('a linked native question keeps one identity; a parent cannot fabricate its user answer', () => {
  let state = { ...committed(), revision: 1, deliveries: {} };
  state = reduceCoordination(state, { kind: 'reply_prepared', revision: 2, message: { id: 'reply', question: { agentRequestId: 'q', expectedRequestRevision: 1 } } });
  assert.equal(state.agentRequests.q.userRequestRef, 'card:question:reply:reply');
  assert.equal(state.agentRequests.q.revision, 2);
  const message = { ...command('answer', 'parent_to_child'), purpose: 'answer' };
  const answer = { requestId: 'q', expectedRequestRevision: 2 };
  assert.throws(() => reduceAgentSupervision(state, { kind: 'agent_message_committed', message, receipt: receipt(message), answer }), /agent_request_stale/);
  state = reduceAgentSupervision(state, { kind: 'agent_message_committed', message, receipt: receipt(message), answer: { ...answer, sourceInputId: 'real-user-input', userRequestRef: 'card:question:reply:reply' } });
  assert.equal(state.agentRequests.q.status, 'answered');
});

test('notes use compare-and-swap and windows cannot cross an absent predecessor', () => {
  const note = { noteId: 'n', workId: 'work', conversationId: 'parent', text: 'Evidence still needs checking.' };
  const state = reduceAgentSupervision({}, { kind: 'work_note_written', note, expectedRevision: 0 });
  assert.throws(() => reduceAgentSupervision(state, { kind: 'work_note_written', note, expectedRevision: 0 }), /conflict/);
  assert.throws(() => reduceAgentSupervision(state, { kind: 'context_window_opened', window: { windowId: 'next', workId: 'work', conversationId: 'parent', state: 'prepared', budgetRef: 'work', previousWindowId: 'missing' } }), /previous_missing/);
});

async function world(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-supervision-'));
  let held = true;
  const options = { rootDir, workspaceId: 'w', holdsLease: () => held, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true };
  const stores = [], open = () => { const store = createWorkCoordinationStore(options); stores.push(store); return store; };
  const store = open(); await store.prepare();
  store.saveWork({ workId: 'work', parentConversationId: 'parent', state: 'waiting_children' });
  store.decide({ operationId: 'spawn', workId: 'work', expectedRevision: 0, action: 'parallel', reason: 'User task', sourceInputIds: ['u'], sourceEventIds: [] },
    { workspaceId: 'w', parentConversationId: 'parent', currentInputIds: ['u'], eventIds: [], holdsLease: true });
  const epoch = store.readLifecycleFacts().transitions.spawn.executionEpoch;
  store.bindSession('work', 1, 'child', { workId: 'work', goalRevision: 1, executionEpoch: epoch });
  const release = registerWorkBudget('w', store);
  t.after(() => { release(); stores.forEach(store => store.close()); rmSync(rootDir, { recursive: true, force: true }); });
  return { rootDir, store, open, epoch, loseLease: () => { held = false; } };
}

test('indexed outbox survives cache and manifest loss without downgrading the writer fence', async t => {
  const w = await world(t), delivery = createAgentDelivery({ storeFor: () => w.store });
  const message = command(); delivery.commit(message, { request });
  const dir = path.join(w.rootDir, 'w');
  w.store.close();
  rmSync(path.join(dir, '.read-models'), { recursive: true, force: true });
  rmSync(path.join(dir, 'coordination-v2', 'manifest.json'));
  const restored = w.open(); await restored.prepare();
  assert.equal(restored.readSupervision('agentRequests', 'q').status, 'open');
  assert.equal(restored.querySupervision('agentCommands', 'sessionId', 'child', { pendingOnly: true }).length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'coordination-v2', 'manifest.json'))).minimumWriterVersion, 5);
});

test('conflicting operations and a second unresolved question cannot poison the journal', async t => {
  const w = await world(t), delivery = createAgentDelivery({ storeFor: () => w.store });
  const message = command(); delivery.commit(message, { request });
  assert.throws(() => delivery.commit({ ...message, payloadHash: 'different' }), /agent_operation_conflict/);
  const next = command('another');
  assert.throws(() => delivery.commit(next, { request: { ...request, requestId: 'another' } }));
  assert.equal(w.store.readSupervision('agentMessages', 'another'), undefined);
  assert.equal(delivery.commit(message).replayed, true);
  w.loseLease();
  assert.throws(() => delivery.update(message, { admission: 'admitted' }), /lease_lost/);
});

test('structured options resolve once and admitted-but-unconfirmed resume is reconciled, not replayed', async t => {
  const w = await world(t);
  const origin = { workspaceId: 'w', workId: 'work', sessionId: 'child', parentConversationId: 'parent', phase: 'running',
    coordinationBinding: { workId: 'work', goalRevision: 1, executionEpoch: w.epoch } };
  const plan = { planId: 'plan', conversationId: 'child-conversation', status: 'executing', delegationOrigin: origin };
  let resumes = 0;
  const communication = createSupervisedCommunication({ publish() {}, patchOrigin(plan, patch) { Object.assign(plan.delegationOrigin, patch); },
    resume() { resumes++; }, conversationStore: { getPersistedConversationHistory() { return { messages: [] }; }, appendMessage() {} }, now: () => 'now', canManageWorkspace: () => true });
  const worker = { role: 'work_session', workId: 'work', conversationId: 'child-conversation', deliveryKey: 'q', coordinationBinding: origin.coordinationBinding };
  const question = communication.send({ purpose: 'question', text: 'Choose', decisionRequest: { options: [{ optionId: 'one', label: 'One' }], allowText: false } }, worker, plan);
  const parent = { role: 'project_agent', conversationId: 'parent', deliveryKey: 'a' };
  assert.throws(() => communication.send({ purpose: 'answer', text: 'bad', replyTo: question.messageId, decisionAnswer: { expectedRequestRevision: 1, optionIds: ['bad'] } }, parent, plan), /agent_answer_invalid/);
  const answer = communication.send({ purpose: 'answer', text: 'One', replyTo: question.messageId, decisionAnswer: { expectedRequestRevision: 1, optionIds: ['one'] } }, { ...parent, deliveryKey: 'valid' }, plan);
  assert.equal(resumes, 1);
  const message = w.store.readSupervision('agentMessages', answer.messageId);
  agentDelivery.update(message, { admission: 'admitted', effect: 'pending' });
  communication.recover(plan);
  assert.equal(resumes, 1);
  assert.equal(agentDelivery.receipt('w', answer.messageId).effect, 'unknown');
  assert.equal(agentDelivery.request('w', question.messageId).status, 'answered');
  assert.throws(() => communication.send({ purpose: 'update', text: 'late' }, { ...worker, coordinationBinding: { ...worker.coordinationBinding, executionEpoch: 'old' } }, plan), /agent_execution_stale/);
});


test('bounded admission drains old queued messages and does not acknowledge unseen inbox events', async t => {
  const w = await world(t);
  const events = [];
  for (let index = 0; index < 12; index++) {
    const message = { ...command(`message-${index}`), purpose: 'update', text: `Update ${index}` };
    agentDelivery.commit(message);
    events.push({ eventId: `event-${index}`, kind: 'agent_message', sessionId: 'child', payload: { agentMessage: message } });
  }
  w.store.transfer(events);
  const first = agentMessagesForContext([], 'parent', 'w');
  assert.deepEqual(first.map(message => message.messageId), Array.from({ length: 8 }, (_, index) => `message-${index}`));
  agentDelivery.observed('w', 'parent', first.map(message => message.messageId));
  const next = agentMessagesForContext([], 'parent', 'w');
  assert.deepEqual(next.map(message => message.messageId), ['message-8', 'message-9', 'message-10', 'message-11']);
  const coordination = createRunnerCoordination({ store: w.store, workspaceId: 'w', conversationId: 'parent', inbox: {},
    readMessages: () => [], remember() {}, resolveRoster: () => [] });
  const job = { workId: 'work', attemptId: 'turn', kind: 'wake', userInputs: [], events };
  coordination.start(job);
  coordination.finish(job, { rounds: [], failed: false }, []);
  assert.deepEqual(w.store.pendingEvents().map(event => event.eventId).sort(), ['event-8', 'event-9', 'event-10', 'event-11'].sort());
  assert.equal(w.store.readWork('work').state, 'runnable');
});


test('takeover retains the native plan-approval and user-input gates', () => {
  assert.equal(takeoverHumanBlocker({ status: 'awaiting_approval', runner: { status: 'idle' } }), 'plan_approval_required');
  assert.equal(takeoverHumanBlocker({ status: 'executing', delegationOrigin: { phase: 'awaiting_approval' } }), 'plan_approval_required');
  assert.equal(takeoverHumanBlocker({ status: 'executing', runner: { status: 'waiting_user' } }), 'human_decision_required');
  assert.equal(takeoverHumanBlocker({ status: 'interrupted', runner: { status: 'failed' } }), null);
});

test('an older queued obligation survives more than one recent-history page', async t => {
  const w = await world(t);
  for (let index = 0; index < 120; index++) agentDelivery.commit({ ...command(`queued-${index}`), purpose: 'update', text: `Update ${index}` });
  const seen = [];
  while (seen.length < 120) {
    const batch = agentMessagesForContext([], 'parent', 'w');
    assert.deepEqual(batch.map(message => message.messageId), Array.from({ length: 8 }, (_, index) => `queued-${seen.length + index}`));
    seen.push(...batch.map(message => message.messageId));
    agentDelivery.observed('w', 'parent', batch.map(message => message.messageId));
  }
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(w.store.querySupervision('agentMessages', 'recipientConversationId', 'parent', { pendingOnly: true }), []);
  w.store.close();
  rmSync(path.join(w.rootDir, 'w', '.read-models'), { recursive: true, force: true });
  const restored = w.open(); await restored.prepare();
  assert.deepEqual(restored.querySupervision('agentMessages', 'recipientConversationId', 'parent', { pendingOnly: true }), []);
});
