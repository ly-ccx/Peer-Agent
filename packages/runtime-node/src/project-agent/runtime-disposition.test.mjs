import assert from 'node:assert/strict';
import test from 'node:test';
import { projectWorkSession } from '@peer-agent/protocol';
import { decideRuntimeDisposition } from './runtime-disposition.ts';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { sessionFactsFromPlan, beginExecutionAttempt } from './session-facts.mjs';
import { intentWorkDisposition } from './intent-lifecycle.mjs';
import { ownedSessions } from './repair-ownership.mjs';
import { createRunnerReplyLifecycle } from './runner-reply-lifecycle.mjs';
import { reconcileRepairCustody } from './repair-custody.mjs';
import { replyRecoveryAdmission } from './reply-recovery-admission.mjs';

const stopped = { sessionId: 'old', status: 'cancelled', followUp: { owner: 'bot', reason: 'stop_unconfirmed' } };

test('delegation custody agrees across finish and delivered-reply recovery without overriding a human or stop gate', async () => {
  for (const retryable of [true, false]) {
    for (const route of ['finish', 'reply']) {
      let work = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: 'runnable',
        attemptId: 'attempt', sessionIds: [], anchorInputIds: [], consumedEventIds: [], pendingEventIds: [], checkpointRef: 'cp',
        delegationFollowUp: { blockers: [{ taskKey: 'task', sourceTurnId: 'attempt', toolCallId: 'dispatch', action: 'parallel',
          error: retryable ? 'anchor_not_found' : 'current_user_required', retryable }] } };
      const message = { id: 'reply', turnId: 'attempt', kind: 'agent_reply', content: '仍在处理', meta: { workId: 'work' } };
      const store = { read: () => ({ works: { work }, events: {}, deliveries: { reply: { state: 'delivered', message } } }),
        readWork: () => work, saveWork: next => { work = next; }, handled() {}, checkpoint: () => 'cp',
        readCheckpoint: () => ({ outcome: { rounds: [] } }) };
      if (route === 'finish') {
        createRunnerCoordination({ store, workspaceId: 'w', conversationId: 'p', readMessages: () => [], resolveRoster: () => [] })
          .finish({ workId: 'work', events: [] }, { rounds: [] }, []);
      } else {
        await createRunnerReplyLifecycle({ store, workspaceId: 'w', conversationId: 'p', readMessages: () => [message],
          resolveRoster: () => [], eventObserved: () => true }).recover();
      }
      assert.equal(work.state, retryable ? 'runnable' : 'blocked_system', route);
      assert.equal(work.delegationFollowUp.blockers.length, 1);
      assert.equal(decideRuntimeDisposition({ previous: { ...work, state: 'cancelled', stopScope: 'work' } }).state, 'cancelled');
      assert.equal(decideRuntimeDisposition({ previous: work, reportedWait: { waitingUser: true, sessionStates: [] } }).state, 'waiting_user');
    }
  }
});

test('user control dominates semantic continue, unseen events and delivery recovery', () => {
  for (const state of ['paused', 'cancelled']) {
    const result = decideRuntimeDisposition({ previous: { state, stopScope: 'work' }, sessions: [stopped],
      semantic: { state: 'runnable' }, unseenEvents: true, outcome: { deliveryPending: true } });
    assert.equal(result.state, state);
    assert.equal(result.handling, 'none');
  }
  assert.equal(decideRuntimeDisposition({ outcome: { stopped: true }, sessions: [{ sessionId: 'child', status: 'running' }] }).state, 'waiting_children');
  assert.equal(replyRecoveryAdmission({ state: 'paused', stopScope: 'work' }, {}).code, 'STALE_TURN');
  assert.equal(replyRecoveryAdmission({ state: 'runnable', pendingControl: { action: 'cancel' } }, {}).code, 'STALE_TURN');
});

test('host stop settlement has a concrete wait and never becomes a model repair item', () => {
  const result = decideRuntimeDisposition({ sessions: [stopped] });
  assert.equal(result.state, 'waiting_children');
  assert.equal(result.handling, 'host');
  assert.deepEqual(result.repairSessionIds, []);
  assert.deepEqual(result.waitFor, [{ kind: 'session', id: 'old' }]);
  assert.equal(decideRuntimeDisposition({ sessions: [stopped], semantic: { state: 'runnable' }, unseenEvents: true }).handling, 'host');
  const missing = decideRuntimeDisposition({ previous: { sessionIds: ['missing'] }, semantic: { state: 'runnable' } });
  assert.equal(missing.handling, 'host'); assert.deepEqual(missing.waitFor, [{ kind: 'session', id: 'missing' }]);
});

test('mere sources do not grant a fresh cancellation work custody of a legacy session', () => {
  const work = { workId: 'cancel', sessionIds: [], anchorInputIds: ['cancel-input'] };
  assert.deepEqual(ownedSessions(work, { events: [] }, [stopped], ['old']), []);
  assert.deepEqual(ownedSessions(work, { events: [{ sessionId: 'old' }] }, [stopped]), []);
  assert.deepEqual(ownedSessions({ ...work, pendingEventIds: ['event'] }, { events: [{ eventId: 'event', sessionId: 'old' }] }, [stopped]), [stopped]);
  const bound = { ...stopped, origin: { workId: 'cancel' } };
  assert.deepEqual(ownedSessions(work, { events: [] }, [bound], ['old']), [bound]);
});

test('an admitted silent wait preserves progress history even with an active root intent', () => {
  let work = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: 'runnable', stopScope: 'reply',
    sessionIds: ['child'], anchorInputIds: [], consumedEventIds: [], pendingEventIds: [], checkpointRef: 'cp',
    fingerprint: 'seen', repeats: 1, progressFacts: ['fact'], intentCoordination: { lifecycle: 'active' } };
  const store = { read: () => ({ works: { work } }), checkpoint: () => 'next', readCheckpoint: () => null,
    saveWork: next => { work = next; }, handled() {} };
  const coordinator = createRunnerCoordination({ store, inbox: {}, workspaceId: 'w', conversationId: 'p',
    readMessages: () => [], remember() {}, resolveRoster: () => [] });
  coordinator.finish({ workId: 'work', events: [] }, { silentWait: { source: 'tool', sessionIds: ['child'] }, rounds: [] }, []);
  assert.equal(work.state, 'waiting_children');
  assert.equal(work.repeats, 1);
  assert.equal(work.fingerprint, 'seen');
  assert.deepEqual(work.progressFacts, ['fact']);
  assert.deepEqual(work.waitFor, [{ kind: 'session', id: 'child' }]);
  assert.equal(work.intentCoordination.lifecycle, 'active');
});

test('real execution facts flow through the public projection into root closure without object-shaped ownership', t => {
  const plan = { planId: 'plan', conversationId: 'child-conversation', title: 'Task', status: 'completed', runner: { status: 'completed' },
    delegationOrigin: { sessionId: 'child', workspaceId: 'w', parentConversationId: 'p' } };
  const release = beginExecutionAttempt(plan.conversationId, 'attempt'); t.after(release);
  const facts = sessionFactsFromPlan(plan);
  const session = projectWorkSession({ ...plan, delegated: true, accepted: true }, {
    workspaceId: 'w', sessionId: 'child', origin: plan.delegationOrigin, accepted: true, executionOwnership: facts.executionOwnership,
  });
  let observed;
  const work = { workId: 'work', intentCoordination: { lifecycle: 'active', revision: 1, goalRevision: 1,
    decision: { operationId: 'decision', disposition: { kind: 'return' } }, review: {} } };
  const state = { mandates: { work: { goalRevision: 1, sessionIds: ['child'] } } };
  intentWorkDisposition({ work, state, sessions: [session], parentConversationId: 'p', sourcesCurrent: () => true,
    store: { closeIntent: (_input, host) => { observed = host; return { ok: false, error: 'pending_obligations' }; } } });
  assert.equal(session.executionOwnership, 'live');
  assert.equal(observed.pendingObligations, true);
});

test('normal completion, delivered-reply recovery and repair custody agree on the same technical obligation', async () => {
  const sessions = [{ sessionId: 'child', status: 'failed', executionOwnership: 'ended', origin: { workId: 'work' } }];
  const results = [];
  for (const route of ['finish', 'reply', 'custody']) {
    let work = { workId: 'work', workspaceId: 'w', parentConversationId: 'p', state: route === 'custody' ? 'delivered' : 'runnable',
      attemptId: 'attempt', sessionIds: ['child'], anchorInputIds: [], consumedEventIds: [], pendingEventIds: [], checkpointRef: 'cp' };
    const message = { id: 'reply', turnId: 'attempt', meta: { workId: 'work' }, sources: ['child'] };
    const store = { read: () => ({ works: { work }, events: {}, deliveries: { reply: { state: 'delivered', message } } }),
      readWork: () => work, saveWork: next => { work = next; }, handled() {}, checkpoint: () => 'cp',
      readCheckpoint: () => ({ outcome: { rounds: [] } }) };
    if (route === 'finish') {
      const coordination = createRunnerCoordination({ store, inbox: {}, workspaceId: 'w', conversationId: 'p', readMessages: () => [], resolveRoster: () => sessions });
      coordination.finish({ workId: 'work', events: [] }, { rounds: [] }, sessions);
    } else if (route === 'reply') {
      await createRunnerReplyLifecycle({ store, workspaceId: 'w', conversationId: 'p', readMessages: () => [message],
        resolveRoster: () => sessions, eventObserved: () => true }).recover();
    } else reconcileRepairCustody({ store, conversationId: 'p', sessions });
    results.push({ state: work.state, end: work.end, repairSessionIds: work.repairSessionIds, waitFor: work.waitFor });
  }
  assert.deepEqual(results[0], { state: 'runnable', end: 'yielded', repairSessionIds: ['child'], waitFor: [] });
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0]);
});
