import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyCancellationStopped, legacyTakeoverIdle } from './legacy-stop-proof.mjs';

const requestedAt = '2026-10-29T01:00:00.000Z', completedAt = '2026-10-29T01:01:00.000Z';
function cancelled() {
  return { delegationOrigin: { cancellation: { phase: 'completed', requestedAt, completedAt, reason: 'superseded' } },
    revisionHistory: [{ changedBy: 'session-cancellation', changedAt: completedAt, reason: 'superseded' },
      { changedBy: 'session-cancellation', changedAt: completedAt, reason: 'cancellation cleanup settled' }] };
}
test('legacy automatic cancellation uses the actual post-idle audit, without inventing a user withdrawal', () => {
  const plan = cancelled(); assert.equal(legacyCancellationStopped(plan), true);
  plan.revisionHistory.push({ changedBy: 'session-control', reason: 'execution control receipt' });
  assert.equal(legacyCancellationStopped(plan), true);
  assert.equal(plan.delegationOrigin.cancellation.withdrawal, undefined);
  plan.revisionHistory.push({ changedBy: 'session-supervisor', reason: 'scheduler admitted session' });
  assert.equal(legacyCancellationStopped(plan), false);
});
test('bare completion, mismatched audit, reversed time and a later generation cannot prove legacy stop', () => {
  for (const change of [p => { p.revisionHistory = []; }, p => { p.revisionHistory[0].reason = 'other'; },
    p => { p.delegationOrigin.cancellation.requestedAt = '2026-10-30T00:00:00.000Z'; },
    p => { p.delegationOrigin.executionGeneration = 'resumed'; }]) {
    const plan = cancelled(); change(plan); assert.equal(legacyCancellationStopped(plan), false);
  }
});
function idleTakeover() {
  return { planId: 'plan', conversationId: 'child', status: 'paused', runner: { status: 'paused' },
    delegationOrigin: { workspaceId: 'workspace', sessionId: 'session', parentConversationId: 'parent', phase: 'paused',
      takeover: { operationId: 'takeover', phase: 'stopping', requestedAt: completedAt } },
    revisionHistory: [{ changedBy: 'session-verification', reason: 'verification verdict', changedAt: requestedAt },
      { changedBy: 'session-takeover', reason: 'coordinator executor takeover', changedAt: completedAt }],
    runTrace: { events: [{ goalPlanId: 'plan', type: 'step_started', payload: { summaryCode: 'turn_started', turnNumber: 1 } },
      { goalPlanId: 'plan', type: 'step_completed', createdAt: requestedAt,
        payload: { summaryCode: 'turn_completed', turnNumber: 1, terminalStatus: 'done' } }] } };
}
test('idle legacy takeover needs both worker completion and verifier return with no later dispatch', () => {
  assert.equal(legacyTakeoverIdle(idleTakeover()), true);
  for (const change of [p => { p.runTrace.events.pop(); }, p => { p.revisionHistory[0].reason = 'independent verification'; },
    p => { p.runTrace.events.push({ type: 'step_started' }); }, p => { p.delegationOrigin.executionGeneration = 'new'; }]) {
    const plan = idleTakeover(); change(plan); assert.equal(legacyTakeoverIdle(plan), false);
  }
});
