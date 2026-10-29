import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFactsFromPlan, beginVerificationAttempt } from './session-facts.mjs';
import { watchFactsFromPlan } from './watchdog.mjs';
import { createRunnerCoordination } from './runner-coordination.mjs';
import { mapDelegationEvents } from './event-mapper.mjs';
import { repairOwnership, stateAfterReply } from './repair-ownership.mjs';

const blocked = () => ({ planId: 'p', status: 'executing', tasks: [],
  delegationOrigin: { sessionId: 's', phase: 'running' },
  runner: { status: 'blocked', blockedReason: 'Verification gate failed: quality:criterion_unverified' } });

test('a failed delegated stream retains parent responsibility after a public update', () => {
  const plan = { planId: 'p', status: 'interrupted', delegationOrigin: { sessionId: 's', phase: 'running' },
    runner: { status: 'failed', lastError: 'conversation_persistence_failed: EIO',
      interruption: { source: 'stream_error', recoverable: false, reason: 'conversation_persistence_failed: EIO' } } };
  const session = { sessionId: 's', ...sessionFactsFromPlan(plan) };
  assert.deepEqual(repairOwnership([session]).repairSessionIds, ['s']);
  assert.equal(stateAfterReply([session]), 'runnable');
  const events = mapDelegationEvents({ sessions: [{ ...session, status: 'running' }] }, { sessions: [watchFactsFromPlan(plan)] });
  assert.equal(events.find(row => row.kind === 'interrupted').payload.reason, 'conversation_persistence_failed: EIO');
  assert.equal(events.some(row => row.kind === 'needs_user'), false);
  const stopped = sessionFactsFromPlan({ ...plan, runner: { ...plan.runner,
    interruption: { ...plan.runner.interruption, origin: 'user' } } });
  assert.equal(stopped.status, 'paused', 'the runtime adapter must preserve an explicit user stop');
});

test('technical verification blockers belong to the parent and cannot manufacture human questions', () => {
  const plan = blocked();
  assert.equal(sessionFactsFromPlan(plan).status, 'waiting_agent');
  assert.equal(sessionFactsFromPlan(plan).needsUser, false);
  assert.equal(watchFactsFromPlan(plan).needsUser, undefined);
  const end = beginVerificationAttempt('p', 'recheck');
  try { assert.equal(sessionFactsFromPlan(plan).status, 'verifying'); } finally { end(); }
});

test('real human and stopped facts retain priority over repair and verification', () => {
  for (const reason of ['manual_dod_confirmation_required', 'question']) {
    const plan = blocked(); plan.runner.blockedReason = reason;
    if (reason === 'question') plan.runner.waitingOnUser = true;
    assert.equal(sessionFactsFromPlan(plan).status, 'waiting_user');
    assert.equal(watchFactsFromPlan(plan).needsUser[0].kind, 'question');
  }
  const plan = blocked(); plan.delegationOrigin.phase = 'paused';
  assert.equal(sessionFactsFromPlan(plan).status, 'paused');
});

test('an incomplete technical blocker wakes the parent once without manufacturing a user request', () => {
  const plan = blocked(); plan.tasks = [{ taskId: 't', status: 'pending' }];
  const facts = { sessions: [watchFactsFromPlan(plan)] };
  const events = mapDelegationEvents({ sessions: [] }, facts);
  assert.equal(events.some(row => row.kind === 'needs_user'), false);
  assert.equal(events.find(row => row.kind === 'report_available').payload.owner, 'parent_agent');
  assert.deepEqual(mapDelegationEvents(facts, facts), []);
});

function coordinationFixture(state = 'runnable') {
  let work = { workId: 'w', parentConversationId: 'parent', state, sessionIds: ['s'],
    anchorInputIds: ['i'], consumedEventIds: [], pendingEventIds: ['e'], checkpointRef: 'cp' };
  const roster = [{ sessionId: 's', ...sessionFactsFromPlan(blocked()) }];
  const handled = [];
  const checkpoint = { job: { workId: 'w', events: [{ eventId: 'e', sessionId: 's' }] }, outcome: { rounds: [] } };
  const store = { read: () => ({ works: { w: work } }), saveWork: value => { work = value; },
    checkpoint: () => 'cp', readCheckpoint: () => checkpoint, handled: ids => handled.push(...ids) };
  const coordination = createRunnerCoordination({ store, inbox: {}, workspaceId: 'workspace', conversationId: 'parent',
    readMessages: () => [], remember: () => {}, resolveRoster: () => roster });
  return { coordination, work: () => work, roster, handled };
}

test('a public progress reply transfers event custody while retaining runnable repair responsibility', () => {
  const f = coordinationFixture();
  f.coordination.finish({ workId: 'w', events: [{ eventId: 'e', sessionId: 's' }] },
    { yielded: false, rounds: [{ toolCalls: [{ name: 'post_reply', input: { text: '复核尚未完成' }, result: { ok: true } }] }] }, f.roster);
  assert.equal(f.work().state, 'runnable');
  assert.equal(f.work().end, 'yielded');
  assert.deepEqual(f.work().repairSessionIds, ['s']);
  assert.deepEqual(f.handled, ['e']);
  assert.equal(f.coordination.recoverJob().workId, 'w');
});

test('legacy false waiting_user recovers from current facts without a fresh allowance', () => {
  const f = coordinationFixture('waiting_user');
  assert.equal(f.coordination.recoverJob().workId, 'w');
  assert.equal(f.work().state, 'runnable');
  f.roster[0].status = 'waiting_user'; f.roster[0].needsUser = true;
  f.coordination.finish({ workId: 'w', events: [] }, { yielded: false, rounds: [] }, f.roster);
  assert.equal(f.work().state, 'waiting_user');
  assert.equal(f.coordination.recoverJob(), null);
});

test('repeated identical repair observations stop automatically; cancellation remains stopped', () => {
  const f = coordinationFixture();
  for (let i = 0; i < 3; i++) f.coordination.finish({ workId: 'w', events: [] },
    { yielded: false, rounds: [{ toolCalls: [{ name: 'get_session', result: { status: 'waiting_agent' } }] }] }, f.roster);
  assert.equal(f.work().state, 'blocked_system');
  const stopped = coordinationFixture();
  stopped.coordination.finish({ workId: 'w', events: [] }, { stopped: true, rounds: [] }, stopped.roster);
  assert.equal(stopped.work().state, 'paused');
});

test('rephrased public progress cannot reset the repair no-progress protection', () => {
  const f = coordinationFixture();
  for (let i = 0; i < 3; i++) f.coordination.finish({ workId: 'w', events: [] },
    { yielded: false, rounds: [{ toolCalls: [{ name: 'post_reply', input: { text: `I am still checking ${i}` }, result: { ok: true } }] }] }, f.roster);
  assert.equal(f.work().state, 'blocked_system');
  assert.equal(f.work().end, 'no_progress');
});
