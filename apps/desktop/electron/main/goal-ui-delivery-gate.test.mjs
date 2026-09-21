import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateVerificationGate } from './goal-runner.mjs';

const plan = { tasks: [{ taskId: 'done', status: 'completed', evidenceRefs: ['mechanical'] }] };
for (const host of ['web', 'desktop']) {
  const requirement = { id: 'layout', host, requirementRevision: '1', buildFingerprint: 'build', instanceId: 'instance' };
  const observation = { ...requirement, requirementId: 'layout', evidenceRef: 'observation', artifactHash: 'hash', admittedToRunId: 'run' };
  const judgment = { requirementId: 'layout', observationRef: 'observation', evidenceRef: 'judgment', modelRunId: 'run', decision: 'passed' };
  const options = { uiDeliveryRequired: true, indexedEvidenceRefs: ['mechanical', 'observation', 'judgment'],
    uiDelivery: { requirements: [requirement], observations: [observation], judgments: [judgment] } };
  test(`${host}: completed mechanical task does not bypass absent authority`, () => {
    assert.equal(evaluateVerificationGate(plan, { ...options, uiDelivery: undefined }).passed, false);
  });
  for (const field of ['requirements', 'observations', 'judgments']) {
    test(`${host}: corrupt ${field} fails closed without throwing`, () => {
      const result = evaluateVerificationGate(plan, { ...options,
        uiDelivery: { ...options.uiDelivery, [field]: [null] } });
      assert.equal(result.passed, false);
    });
  }
  test(`${host}: valid host-resolved review passes gate`, () => assert.equal(evaluateVerificationGate(plan, options).passed, true));
  for (const decision of ['failed', 'unknown']) {
    test(`${host}: ${decision} review blocks completed task`, () => {
      assert.equal(evaluateVerificationGate(plan, { ...options, uiDelivery: { ...options.uiDelivery, judgments: [{ ...judgment, decision }] } }).passed, false);
    });
  }
  test(`${host}: stale build blocks gate`, () => {
    assert.equal(evaluateVerificationGate(plan, { ...options, uiDelivery: { ...options.uiDelivery, observations: [{ ...observation, buildFingerprint: 'old' }] } }).passed, false);
  });
  test(`${host}: missing evidence index fails closed`, () => assert.equal(evaluateVerificationGate(plan, { ...options, indexedEvidenceRefs: undefined }).passed, false));
  test(`${host}: model-authored plan data cannot replace host authority`, () => {
    assert.equal(evaluateVerificationGate({ ...plan, uiDelivery: options.uiDelivery }, { ...options, uiDelivery: undefined }).passed, false);
  });
}
test('legacy mechanical-only task keeps its existing completion semantics', () => {
  assert.equal(evaluateVerificationGate(plan, { indexedEvidenceRefs: ['mechanical'] }).passed, true);
});
