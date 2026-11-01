import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecisionFrame } from './decision-frame.mjs';
import { continuationDecision, progressFacts } from './continuation-policy.mjs';
import { normalizedProgressObservations, stableOperationFailureKey } from './progress-policy.mjs';
import { assessSameCause } from './watchdog.mjs';

test('the current old target survives a large roster; errors, versions, omissions and retrieval survive while secrets and other Bots do not', () => {
  const sessions = Array.from({ length: 40 }, (_, i) => ({ sessionId: `s${String(i).padStart(2, '0')}`, workspaceId: 'w',
    origin: { parentConversationId: 'p' }, title: 'Task', status: 'running', sourceRevision: `source-${i}`, observationRevision: `obs-${i}` }));
  sessions.push({ sessionId: 'foreign', workspaceId: 'w', origin: { parentConversationId: 'another-bot' }, title: 'PRIVATE_FOREIGN' });
  const state = { works: { g: { workId: 'g', workspaceId: 'w', parentConversationId: 'p', state: 'runnable', sessionIds: [] } },
    mandates: { g: { goalRevision: 2, lifecycle: 'active', allowedActions: ['parallel'], sessionIds: sessions.map(row => row.sessionId) } },
    events: { old: { event: { eventId: 'old', sessionId: 's00', kind: 'interrupted', payload: { reason: 'ECONNRESET while reviewing', lastError: 'API_KEY=hidden',
      privateThoughts: 'PRIVATE_THOUGHTS', credentials: 'PRIVATE_SECRET', sameCauseCount: 2 } } } } };
  const frame = createDecisionFrame({ state, sessions: [...sessions].reverse(), workspaceId: 'w', parentConversationId: 'p', workId: 'g', eventIds: ['old'] });
  assert.equal(frame.sessions[0].sessionId, 's00'); assert.equal(frame.sessions.length, 24); assert.equal(frame.omitted.sessions, 16);
  assert.equal(frame.events[0].eventId, 'old'); assert.equal(frame.events[0].payload.reason, 'ECONNRESET while reviewing');
  assert.equal(frame.events[0].payload.sameCauseCount, 2); assert.equal(frame.retrieval.expectedRevision, 2);
  assert.ok(frame.retrieval.afterSessionId); assert.equal(frame.truncated, true);
  assert.doesNotMatch(JSON.stringify(frame), /PRIVATE_|hidden/);
  assert.equal(createDecisionFrame({ state, sessions, workspaceId: 'w', parentConversationId: 'another-bot', workId: 'g' }), null);
  const next = createDecisionFrame({ state, sessions, workspaceId: 'w', parentConversationId: 'p', workId: 'g', eventIds: ['old'], afterSessionId: frame.retrieval.afterSessionId });
  assert.equal(next.sessions.length, 16); assert.equal(next.omitted.sessions, 0);
});

test('worst-sized factual input remains bounded and explicitly retrieves clipped requirements', () => {
  const state = { works: { g: { workId: 'g', workspaceId: 'w', parentConversationId: 'p', intentCoordination: { revision: 1, lifecycle: 'active',
    interpretation: { outcome: '长'.repeat(4000), constraints: Array(16).fill('约'.repeat(500)), nonGoals: [], openQuestions: [],
      requirements: Array.from({ length: 32 }, (_, i) => ({ requirementId: `r${i}`, text: '要'.repeat(1000), sourceInputIds: Array(20).fill('input-source') })) },
    coverage: [], decision: { operationId: 'd', disposition: { kind: 'continue' } } } } } };
  const frame = createDecisionFrame({ state, workspaceId: 'w', parentConversationId: 'p', workId: 'g' });
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 24000); assert.equal(frame.truncated, true);
  assert.ok(frame.omitted.requirements > 0); assert.equal(frame.omitted.text, true);
  assert.equal(frame.retrieval.tool, 'coordinate_work');
});

test('paraphrased failures and changing UUIDs survive restart without gaining progress, while real object identities remain distinct', () => {
  let previous = {};
  for (let i = 0; i < 3; i++) {
    previous = continuationDecision({ previous: JSON.parse(JSON.stringify(previous)), yielded: true, rounds: [{ toolCalls: [{ name: 'coordinate_work',
      input: { action: 'resume', sessionId: 'same-session', reason: `Try wording ${i}` }, result: { ok: false, output: { error: { code: 'ECONNRESET', message: `New wording ${i}` } },
        operationId: `uuid-${i}`, updatedAt: new Date(1000 * i).toISOString() } }] }] });
  }
  assert.equal(previous.end, 'no_progress');
  const facts = id => progressFacts([{ toolCalls: [{ name: 'get_session', input: { sessionId: id }, result: { status: 'running', sessionId: id } }] }]);
  assert.notDeepEqual(facts('actual-object-A'), facts('actual-object-B'));
  const key = stableOperationFailureKey({ workId: 'g', goalRevision: 2, action: 'resume', sessionId: 's', error: 'ECONNRESET at different time' });
  assert.equal(key, stableOperationFailureKey({ workId: 'g', goalRevision: 2, action: 'resume', sessionId: 's', error: 'ECONNRESET: rephrased diagnosis' }));
});

test('observations, admitted effects and actual goal review are different; random Evidence identities and assessment prose do not renew progress', () => {
  const read = ref => [{ toolCalls: [{ name: 'read_file', input: { path: '/actual' }, result: { ok: true, output: { content: 'Same actual bytes' }, evidenceRefs: [ref] } }] }];
  assert.deepEqual(progressFacts(read('ev-1')), progressFacts(read('ev-2')));
  const records = normalizedProgressObservations([{ toolCalls: [
    { name: 'read_file', result: { ok: true, content: 'New investigation finding' } },
    { name: 'coordinate_work', input: { action: 'resume' }, result: { ok: true, phase: 'completed', sessionId: 's' } },
    { name: 'coordinate_work', input: { action: 'assess' }, result: { ok: true, receipt: { workId: 'g' }, review: { passed: true, sources: [{ sessionId: 's' }] } } },
  ] }]);
  assert.deepEqual(records.map(row => row.kind), ['observed', 'admitted', 'advanced']);
  assert.deepEqual(progressFacts([{ toolCalls: [{ name: 'coordinate_work', input: { action: 'assess', reason: 'Changed story' }, result: { ok: true, operationId: 'new' } }] }]), []);
  const same = assessSameCause({ workId: 'g', goalRevision: 2, sessionId: 'new-executor', interruption: { reason: 'ECONNRESET now' }, failureLog: [
    { workId: 'g', goalRevision: 2, cause: 'ECONNRESET before' }, { workId: 'g', goalRevision: 2, cause: 'ECONNRESET differently worded' }] });
  assert.equal(same.stopAutoRetry, true);
});
