import assert from 'node:assert/strict';
import test from 'node:test';
import { criterionSourceRevision } from './criterion-review.mjs';
import { verificationHistory } from './verification-history.mjs';

test('review diagnostics retain the real cause, version binding and later success without inferring from models', () => {
  const plan = { planId: 'p', tasks: [], runner: { verifierRuns: [
    { verifierRunId: 'old', target: { kind: 'plan' }, status: 'failed',
      report: { failedCriteria: [{ criterionId: 'review', reason: 'Missing visual review', evidenceRefs: ['ev-real', 'ev-forged'] }] } },
    { verifierRunId: 'timeout', target: { kind: 'plan' }, status: 'failed', failureReason: 'agent_loop_exhausted: 12 turns',
      report: { risks: ['Review did not finish'], recommendedNextAction: 'inspect_and_repair' } },
    { verifierRunId: 'fresh', target: { kind: 'plan' }, status: 'passed', evidenceRefs: ['ev-real'] },
  ] } };
  plan.modelReviews = [{ verifierRunId: 'old', sourceRevision: 'old-revision' },
    { verifierRunId: 'fresh', sourceRevision: criterionSourceRevision(plan) }];
  const rows = verificationHistory(plan, ['ev-real']);
  assert.deepEqual(rows.map(row => row.matchesCurrentSource), [false, null, true]);
  assert.ok(rows.every(row => row.diagnosticOnly === true));
  assert.equal(rows[0].failedCriteria[0].reason, 'Missing visual review');
  assert.deepEqual(rows[0].failedCriteria[0].evidenceRefs, ['ev-real']);
  assert.equal(rows[1].failureReason, 'agent_loop_exhausted: 12 turns');
  assert.equal(rows[2].status, 'passed');
  assert.equal(rows[2].failureReason, '');
});

test('diagnostics are bounded, exclude leaf/running records and leave an absent cause unknown', () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({ verifierRunId: String(i), target: { kind: 'plan' }, status: 'failed',
    report: { risks: Array(20).fill('x'.repeat(2000)), failedCriteria: Array(20).fill({ reason: 'y'.repeat(2000) }) } }));
  runs.push({ verifierRunId: 'leaf', target: { kind: 'task' }, status: 'failed' },
    { verifierRunId: 'active', target: { kind: 'plan' }, status: 'running' });
  const rows = verificationHistory({ runner: { verifierRuns: runs } });
  assert.deepEqual(rows.map(row => row.verifierRunId), ['2', '3', '4']);
  assert.equal(rows[0].failureReason, '');
  assert.equal(rows[0].risks.length, 3);
  assert.equal(rows[0].risks[0].length, 400);
  assert.equal(rows[0].failedCriteria.length, 3);
  assert.equal(rows[0].failedCriteria[0].reason.length, 400);
  assert.deepEqual(verificationHistory({ verificationOutcome: 'passed', runner: { verifierRuns: [{ status: 'passed' }] } }), []);
});
