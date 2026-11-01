import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkCoordinationStore } from './work-coordination-store.mjs';
import { registerWorkBudget } from './work-budget.mjs';
import { createCoordinationLifecycle } from './coordination-lifecycle.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { validateDelegationInput } from './tool-specs.mjs';
import { buildVerifierMessage } from './goal-runner-host.mjs';

async function fixture(t) {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'peer-intent-lifecycle-'));
  const store = createWorkCoordinationStore({ rootDir, workspaceId: 'w', holdsLease: () => true, leaseEpoch: () => 'owner', formatVersion: 2, fenceLegacyWrites: true });
  await store.prepare(); const release = registerWorkBudget('w', store);
  t.after(() => { release(); store.close(); rmSync(rootDir, { recursive: true, force: true }); });
  const messages = [{ id: 'input-i', inputId: 'i', role: 'user', kind: 'user_input', content: 'Research and implement the fix' }];
  const sessions = new Map(); let reviews = 0;
  const lifecycle = createCoordinationLifecycle({ holdsLease: () => true, readMessages: () => messages,
    readSession: ({ sessionId }) => sessions.get(sessionId), readGoalFacts: id => ({ plan: { planId: id, goal: 'Stage', successCriteria: [] }, evidenceIndex: [`ev:${id}`], independentVerifier: 'passed' }),
    verifyGoal: async ({ goalReview }) => { reviews++; assert.equal(goalReview.canonicalInputs[0].text, messages[0].content);
      assert.equal(goalReview.requirements.length, 2); return { passed: true, evidenceRefs: ['ev:s1', 'ev:s2'] }; },
    spawn: async (_task, context) => { const id = `s${sessions.size + 1}`;
      store.bindSession('g', context.coordinationBinding.goalRevision, id, { ...context.coordinationBinding, sessionId: id });
      const row = { sessionId: id, workspaceId: 'w', status: 'running', sourceRevision: `source:${id}`, observationRevision: `obs:${id}`,
        origin: { parentConversationId: 'p', workId: 'g', anchorMessageId: 'input-i' } }; sessions.set(id, row); return row; },
    requestCancel: async () => ({ pending: false }), send: async () => ({ ok: true }), takeover: async () => ({ ok: true }) });
  const coordinator = createRunnerCoordination({ store, workspaceId: 'w', conversationId: 'p', inbox: {}, readMessages: () => messages,
    remember: message => messages.push(message), onReplied: async () => { sessions.forEach(row => { if (row.status === 'result_ready') row.status = 'accepted'; }); },
    resolveRoster: () => [...sessions.values()] });
  const job = { workId: 'g', kind: 'user', attemptId: 't1', userInputs: [{ inputId: 'i' }], events: [] }; coordinator.start(job);
  const context = (turnId, extra = {}) => ({ workspaceId: 'w', conversationId: 'p', workId: 'g', turnId, deliveryKey: `${turnId}:op`, currentInputAnchors: [], ...extra });
  const initial = { expectedWorkRevision: 0, expectedGoalRevision: 1, workId: 'g', sourceInputIds: ['i'], sourceEventIds: [],
    inputs: [{ inputId: 'i', kind: 'delegate', reason: 'Original implementation request' }],
    interpretation: { outcome: 'Research and implement', constraints: [], nonGoals: [], openQuestions: [], requirements: [
      { requirementId: 'research', text: 'Research cause', sourceInputIds: ['i'] }, { requirementId: 'fix', text: 'Implement fix', sourceInputIds: ['i'] }] },
    coverage: [{ requirementId: 'research', status: 'remaining', explanation: 'Not researched', sources: [] },
      { requirementId: 'fix', status: 'remaining', explanation: 'Not implemented', sources: [] }],
    disposition: { kind: 'wait', waitFor: [{ kind: 'session', id: 's1', revision: 'obs:s1' }] }, reason: 'Research in progress' };
  return { store, lifecycle, coordinator, job, context, initial, sessions, messages, reviews: () => reviews,
    coordinate: (input, ctx) => lifecycle.coordinate({ reason: 'Test intention', ...input }, ctx) };
}

test('research acceptance retains the original goal, continues without user input, then closes once after actual delivery and root review', async t => {
  const f = await fixture(t);
  await f.coordinate({ action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Research' } }, f.context('spawn', { currentInputAnchors: ['input-i'] }));
  const initial = await f.coordinate({ action: 'assess', assessment: f.initial }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  assert.equal(initial.ok, true, JSON.stringify(initial));
  f.coordinator.finish(f.job, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').state, 'waiting_children');
  f.sessions.get('s1').status = 'accepted';
  assert.equal(f.lifecycle.facts('w', 'p')[0].lifecycle, 'active');
  const event = { eventId: 'research-ready', sessionId: 's1', kind: 'report_available' };
  f.store.transfer([event]);
  const wake = { workId: 'g', kind: 'wake', attemptId: 't2', userInputs: [], events: [event] }; f.coordinator.start(wake);
  const continuation = { ...f.initial, interpretation: undefined, inputs: [], sourceInputIds: [], sourceEventIds: [event.eventId], expectedWorkRevision: 1,
    coverage: [{ ...f.initial.coverage[0], status: 'covered', sources: [{ sessionId: 's1', sourceRevision: 'source:s1', evidenceRefs: ['ev:s1'] }] }, f.initial.coverage[1]],
    disposition: { kind: 'continue', operationRefs: ['requirement:fix'] } };
  assert.equal((await f.coordinate({ action: 'assess', assessment: continuation }, f.context('t2', { events: [event] }))).ok, true);
  f.coordinator.finish(wake, { rounds: [] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').state, 'runnable');
  const next = f.coordinator.recoverJob(); assert.equal(next.kind, 'wake'); assert.deepEqual(next.userInputs, []);
  assert.equal(next.sourceDecisionRef, 't2:op');
  next.attemptId = 't3'; f.coordinator.start(next);
  const ctx = f.context('t3', { sourceDecisionRef: next.sourceDecisionRef });
  const task = { action: 'parallel', task: { anchorMessageIds: ['input-i'], brief: 'Implement' } };
  assert.equal((await f.coordinate(task, ctx)).ok, true);
  assert.equal((await f.coordinate(task, ctx)).replayed, true); assert.equal(f.sessions.size, 2);
  f.sessions.get('s2').status = 'result_ready';
  const complete = { ...continuation, expectedWorkRevision: 2, sourceEventIds: [], sourceDecisionRef: next.sourceDecisionRef,
    coverage: [continuation.coverage[0], { ...continuation.coverage[1], status: 'covered', sources: [{ sessionId: 's2', sourceRevision: 'source:s2', evidenceRefs: ['ev:s2'] }] }],
    disposition: { kind: 'return', replyRef: 't3-reply-1' } };
  const result = await f.coordinate({ action: 'assess', assessment: complete }, { ...ctx, deliveryKey: 't3:assess' });
  assert.equal(result.review.passed, true); assert.equal(f.reviews(), 1);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'active');
  await f.coordinator.deliver({ id: 't3-reply-1', kind: 'agent_reply', meta: { workId: 'g' }, sources: ['s1', 's2'] });
  f.coordinator.finish(next, { rounds: [], reportedSessionIds: ['s1', 's2'] }, [...f.sessions.values()]);
  assert.equal(f.store.readWork('g').intentCoordination.lifecycle, 'fulfilled');
  const revision = f.store.read().revision; await f.coordinator.recover(); assert.equal(f.store.read().revision, revision);
  assert.equal(f.sessions.get('s1').status, 'accepted'); assert.equal(f.sessions.size, 2);
});

test('assessment query has no child requirement, forged typed waits fail, and simple discussion creates no mandate', async t => {
  const f = await fixture(t);
  const query = await f.coordinate({ action: 'query', workId: 'g' }, f.context('t1'));
  assert.equal(query.ok, true); assert.equal(query.goalRevision, 0); assert.equal(query.currentReplyRef, 't1-reply-1');
  assert.equal(f.coordinator.dispositionMissing(f.job), false); assert.equal(f.store.read().mandates, undefined);
  const result = await f.coordinate({ action: 'assess', assessment: { ...f.initial, expectedGoalRevision: 0 } }, f.context('t1', { currentInputAnchors: ['input-i'] }));
  assert.equal(result.error, 'wait_source_stale');
  assert.equal(validateDelegationInput('coordinate_work', { action: 'query', workId: 'g', reason: 'Read facts' }).ok, true);
  assert.equal(validateDelegationInput('coordinate_work', { action: 'assess', assessment: f.initial, reason: 'Assign responsibility' }).ok, true);
  assert.equal(validateDelegationInput('coordinate_work', { action: 'assess', assessment: { ...f.initial, permissionGrant: 'fake' }, reason: 'Assign' }).ok, false);
});

test('root reviewer receives the entire canonical goal as factual input without changing child criteria or acceptance', () => {
  const message = buildVerifierMessage({ plan: { goal: 'Research', successCriteria: [] }, goalReview: { canonicalInputs: [{ text: 'Research AND implement' }], requirements: ['Research', 'Implement'] } });
  assert.match(message, /ALL root requirements/); assert.match(message, /Research AND implement/);
  assert.match(message, /never accepts a child/);
});
