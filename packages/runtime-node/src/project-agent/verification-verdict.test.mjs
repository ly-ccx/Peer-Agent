import assert from 'node:assert/strict';
import test from 'node:test';

import { computeVerificationVerdict } from './verification-verdict.mjs';

function plan(tasks, extra = {}) {
  return {
    tasks,
    runner: { verifierRuns: [{ outcome: 'passed', note: 'model says this passed' }] },
    verificationOutcome: 'passed',
    uiDeliveryRequired: true,
    uiDelivery: {
      requirements: [{ id: 'screen' }],
      observations: [{ requirementId: 'screen' }],
      judgments: [{ requirementId: 'screen', passed: true }],
    },
    ...extra,
  };
}

test('a completed leaf with an indexed ref passes, and a missing index fails closed', () => {
  const passed = computeVerificationVerdict(
    plan([{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1', 'ev-missing'] }]),
    new Set(['ev-1']),
    { independentVerifier: 'passed', verifierModel: 'verifier-b', sameFamilyAsWorker: false },
  );
  assert.equal(passed.outcome, 'passed');
  assert.deepEqual(passed.evidenceRefs, ['ev-1']);
  assert.equal(passed.independentVerifier, 'passed');
  assert.equal(passed.verifierModel, 'verifier-b');

  const missingIndex = computeVerificationVerdict(
    plan([{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1'] }]),
    null,
    { independentVerifier: 'not_required' },
  );
  assert.equal(missingIndex.outcome, 'failed');
  assert.deepEqual(missingIndex.evidenceRefs, []);
});

test('model self-reports and runner verifier runs do not count', () => {
  const claimed = computeVerificationVerdict(
    plan([{ taskId: 'leaf', status: 'completed', evidenceRefs: ['not-indexed'] }]),
    new Set(['ev-1']),
    { independentVerifier: 'passed' },
  );
  assert.notEqual(claimed.outcome, 'passed');
  assert.deepEqual(claimed.evidenceRefs, []);
});

test('host verifier failure, empty plans, mixed leaves, and host-only ui delivery', () => {
  const hostFailed = computeVerificationVerdict(
    plan([{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1'] }]),
    new Set(['ev-1']),
    { independentVerifier: 'failed' },
  );
  assert.equal(hostFailed.outcome, 'failed');
  assert.equal(hostFailed.independentVerifier, 'failed');

  const empty = computeVerificationVerdict(plan([]), new Set(['ev-1']), { independentVerifier: 'passed' });
  assert.equal(empty.outcome, 'unverifiable');

  const mixed = computeVerificationVerdict(
    plan([
      {
        taskId: 'parent',
        status: 'completed',
        subtasks: [
          { taskId: 'ok', status: 'completed', evidenceRefs: ['ev-ok'] },
          { taskId: 'no', status: 'pending', evidenceRefs: [] },
        ],
      },
    ]),
    new Set(['ev-ok']),
    { independentVerifier: 'not_required' },
  );
  assert.equal(mixed.outcome, 'partial');
  assert.deepEqual(mixed.evidenceRefs, ['ev-ok']);

  const hostUi = computeVerificationVerdict(
    plan([{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1'] }]),
    new Set(['ev-1']),
    { independentVerifier: 'passed', uiDeliveryRequired: true },
  );
  assert.notEqual(hostUi.outcome, 'passed');
});
