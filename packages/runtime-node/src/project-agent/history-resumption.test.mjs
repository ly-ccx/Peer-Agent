import test from 'node:test';
import assert from 'node:assert/strict';
import { planHistoryResumption, admitHistoryResumption, retainHistoricalWork, recoveryHash } from './history-resumption.mjs';
import { reduceCoordination } from './work-coordination.mjs';

const source = 'a'.repeat(64);
const held = (id, patch = {}) => ({ workId: id, state: 'runnable', revision: 3, checkpointRef: `${id}.json`, anchorInputIds: [id],
  historyRecovery: { disposition: 'held', previousRecovery: null }, recovery: { blockedCode: 'COORDINATION_RECONCILIATION_REQUIRED' }, ...patch });
const checkpoint = id => ({ job: { workId: id, kind: 'user', userInputs: [{ inputId: id, text: 'original request' }] }, outcome: { rounds: [] } });
const state = works => ({ revision: 8, works, events: {}, deliveries: {}, lastRecovery: { sourceFingerprint: source, executionBlocked: true } });
const inspect = { conflicts: [] };
const options = { readCheckpoint: id => checkpoint(id) };
const admission = previous => ({ sourceFingerprint: source, expectedRevision: previous.revision, at: '2026-10-28T00:00:00Z',
  decisions: planHistoryResumption(previous, inspect, options), quarantinedSessionIds: ['orphan-child'], quarantinedInputIds: ['legacy-input'] });

test('admission partitions work without changing completed results, receipts, checkpoints or input custody', () => {
  const done = { workId: 'done', state: 'delivered', anchorInputIds: ['finished-input'], reportRef: 'report://done' };
  const unknown = held('unknown', { budget: { observations: { receipt: true }, attempts: { a: { pendingTools: [{ toolCallId: 'write' }] } } } });
  const before = state({ done, safe: held('safe'), unknown });
  const original = structuredClone(before), entry = admission(before), next = admitHistoryResumption(before, entry);
  assert.deepEqual(before, original, 'planning and reducing never mutate source history');
  assert.deepEqual(next.works.done, done);
  assert.equal(next.works.safe.state, 'runnable');
  assert.equal(next.works.unknown.state, 'blocked_system');
  assert.deepEqual(next.works.unknown.budget, unknown.budget);
  assert.equal(next.lastRecovery.executionBlocked, false);
  assert.deepEqual(next.lastRecovery.quarantinedInputIds, ['legacy-input']);
  assert.ok(next.lastRecovery.quarantinedSessionIds.includes('orphan-child'));
});

test('admission quarantines historical event ids the inbox accepted, even past 200 characters', () => {
  const longEvent = `supervisor:cancelled:session:${'已合入主工作区'.repeat(30)}`;
  const before = state({ one: held('one') });
  const next = admitHistoryResumption(before, { ...admission(before), quarantinedEventIds: [longEvent] });
  assert.deepEqual(next.lastRecovery.quarantinedEventIds, [longEvent]);
  assert.throws(() => admitHistoryResumption(before, { ...admission(before), quarantinedEventIds: [''] }), /coordination_resume_plan_changed/);
  assert.throws(() => admitHistoryResumption(before, { ...admission(before), quarantinedInputIds: ['x'.repeat(201)] }), /coordination_resume_plan_changed/);
});

test('unpaired tools, missing native tails, changed job identity and conflicting input owners cannot resume', () => {
  const before = state({ a: held('a'), b: held('b', { anchorInputIds: ['a'] }),
    missing: held('missing', { budget: { toolCalls: 1 } }), wrong: held('wrong'), uncertain: held('uncertain', { budget: { uncertainDispatches: [{}] } }) });
  const decisions = planHistoryResumption(before, inspect, { readCheckpoint: id => id === 'wrong' ? checkpoint('different') : checkpoint(id) });
  assert.equal(decisions.every(row => row.disposition === 'held'), true);
  assert.equal(decisions.find(row => row.workId === 'uncertain').reason, 'execution_unknown');
  assert.equal(decisions.find(row => row.workId === 'missing').reason, 'checkpoint_unavailable');
});

test('all historical work must be accounted for with current source, revision and hashes', () => {
  const before = state({ one: held('one'), two: held('two') }), entry = admission(before);
  for (const patch of [{ decisions: entry.decisions.slice(0, 1) }, { expectedRevision: 7 }, { sourceFingerprint: 'b'.repeat(64) },
    { decisions: [entry.decisions[0], entry.decisions[0]] }, { decisions: entry.decisions.map(row => ({ ...row, workHash: 'invented' })) }]) {
    assert.throws(() => admitHistoryResumption(before, { ...entry, ...patch }), /coordination_resume_plan_changed/);
  }
});

test('unfinished coordination and prepared delivery are quarantined even when a native checkpoint exists', () => {
  const before = state({ one: held('one'), two: held('two'), done: { workId: 'done', state: 'delivered' } });
  before.transitions = { operation: { operationId: 'operation', workId: 'one', phase: 'ready' } };
  before.deliveries = { reply: { state: 'prepared', message: { id: 'reply', meta: { workId: 'two' } } },
    oldReply: { state: 'prepared', message: { id: 'oldReply', meta: { workId: 'done' } } } };
  const entry = admission(before), next = admitHistoryResumption(before, entry);
  assert.equal(next.works.one.historyRecovery.reason, 'coordination_pending');
  assert.equal(next.works.two.historyRecovery.reason, 'delivery_pending');
  assert.deepEqual(next.lastRecovery.quarantinedOperationIds, ['operation']);
  assert.deepEqual(next.lastRecovery.quarantinedDeliveryIds, ['reply', 'oldReply']);
});

test('retaining a held execution preserves uncertain receipts and stops rather than reports success', () => {
  const before = state({ one: held('one', { budget: { uncertainDispatches: [{ toolCallId: 'external-write' }] } }) });
  const admitted = admitHistoryResumption(before, admission(before));
  const next = retainHistoricalWork(admitted, { sourceFingerprint: source, expectedRevision: admitted.revision,
    workId: 'one', workHash: recoveryHash(admitted.works.one), at: 'now' });
  assert.equal(next.works.one.state, 'cancelled');
  assert.equal(next.works.one.historyRecovery.disposition, 'retained');
  assert.deepEqual(next.works.one.budget, before.works.one.budget);
  assert.deepEqual(next.works.one.anchorInputIds, ['one']);
  assert.equal(next.works.one.checkpointRef, before.works.one.checkpointRef);
});

test('a later torn-tail recovery receipt cannot erase historical isolation', () => {
  const before = admitHistoryResumption(state({ one: held('one') }), admission(state({ one: held('one') })));
  const next = reduceCoordination(before, { schemaVersion: 1, kind: 'journal_recovered', revision: before.revision + 1, backup: 'damaged.jsonl', at: 'later' });
  assert.deepEqual(next.lastRecovery.quarantinedSessionIds, before.lastRecovery.quarantinedSessionIds);
  assert.deepEqual(next.lastRecovery.quarantinedInputIds, before.lastRecovery.quarantinedInputIds);
});

test('reviewing old holds again does not isolate new work, deliveries or coordination', () => {
  const first = state({ old: held('old', { budget: { uncertainDispatches: [{}] } }) });
  const admitted = admitHistoryResumption(first, admission(first));
  admitted.works.fresh = { workId: 'fresh', state: 'runnable' };
  admitted.deliveries.fresh = { state: 'prepared', message: { id: 'fresh', meta: { workId: 'fresh' } } };
  admitted.transitions = { fresh: { operationId: 'fresh', workId: 'fresh', phase: 'ready' } };
  const next = admitHistoryResumption(admitted, { ...admission(admitted), quarantinedSessionIds: ['orphan-child'] });
  assert.deepEqual(next.works.fresh, admitted.works.fresh);
  assert.equal(next.lastRecovery.quarantinedDeliveryIds.includes('fresh'), false);
  assert.equal(next.lastRecovery.quarantinedOperationIds.includes('fresh'), false);
});

test('rechecking a held human wait or explicit pause cannot silently turn it into runnable work', () => {
  const before = state({ wait: held('wait', { state: 'waiting_user' }), paused: held('paused', { state: 'paused' }) });
  const first = admitHistoryResumption(before, admission(before));
  const second = admitHistoryResumption(first, admission(first));
  assert.equal(second.works.wait.historyRecovery.reason, 'waiting_user');
  assert.equal(second.works.paused.historyRecovery.reason, 'paused');
  assert.equal(second.works.wait.state, 'blocked_system');
});

test('a paired unknown-outcome error is not proof that a historical write failed safely', () => {
  const before = state({ one: held('one') });
  const decisions = planHistoryResumption(before, inspect, { readCheckpoint: () => ({ ...checkpoint('one'),
    outcome: { providerCheckpoint: { messages: [] }, rounds: [{ toolCalls: [{ result: { error: 'execution_outcome_unknown' } }] }] } }) });
  assert.equal(decisions[0].reason, 'execution_unknown'); assert.equal(decisions[0].disposition, 'held');
});
