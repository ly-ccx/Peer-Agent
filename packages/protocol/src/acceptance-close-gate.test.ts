import assert from 'node:assert/strict';
import test from 'node:test';

import type { GoalSuccessCriterion } from './goal.ts';
import {
  AcceptanceCloseGateError,
  assertAcceptanceCloseGate,
  collectHeldEvidenceRefs,
  evaluateAcceptanceCloseGate,
  isAcceptanceClosePatch,
} from './acceptance-close-gate.ts';

const criterion = (id: string, description = id, kind: GoalSuccessCriterion['kind'] = 'manual'): GoalSuccessCriterion => ({
  id,
  kind,
  description,
});

test('empty success criteria pass the close gate', () => {
  const verdict = evaluateAcceptanceCloseGate({ successCriteria: [], criterionResults: [] });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.gaps, []);
});

test('blocks close when a criterion has no result or evidence', () => {
  const verdict = evaluateAcceptanceCloseGate({
    successCriteria: [criterion('c1', '测试通过')],
    criterionResults: [],
    evidenceRefs: [],
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.gaps[0]?.reason, 'missing');
  assert.match(verdict.message, /测试通过/);
});

test('blocks close when evidenceRef is not held or indexed', () => {
  const verdict = evaluateAcceptanceCloseGate({
    successCriteria: [criterion('c1', '文件在', 'file-exists')],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'invented://x' }],
    evidenceRefs: ['local-file://real'],
  }, { knownRefs: ['local-file://real'] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.gaps[0]?.reason, 'unresolved');
});

test('allows close when every criterion has a resolvable passing result', () => {
  const verdict = evaluateAcceptanceCloseGate({
    successCriteria: [criterion('c1', '测试通过', 'test')],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'local-file://tests' }],
    tasks: [{ evidenceRefs: ['local-file://tests'] }],
  }, { knownRefs: ['local-file://tests'] });
  assert.equal(verdict.ok, true);
});

test('manual criteria can close via a later approve confirmation', () => {
  const verdict = evaluateAcceptanceCloseGate({
    successCriteria: [criterion('c1', '口头确认')],
    criterionResults: [],
    manualConfirmations: [{
      confirmationId: 'm1',
      kind: 'manual_dod',
      decision: 'approve',
      criterionIds: ['c1'],
      decidedAt: '2026-08-22T04:00:00.000Z',
    }],
  });
  assert.equal(verdict.ok, true);
});

test('failed criterion blocks close even with a ref', () => {
  const verdict = evaluateAcceptanceCloseGate({
    successCriteria: [criterion('c1', '构建', 'command')],
    criterionResults: [{ criterionId: 'c1', passed: false, evidenceRef: 'local-file://build' }],
  }, { knownRefs: ['local-file://build'] });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.gaps[0]?.reason, 'failed');
});

test('collectHeldEvidenceRefs walks tasks and runTrace, not criterion claims', () => {
  const refs = collectHeldEvidenceRefs({
    evidenceRefs: ['plan://a'],
    tasks: [{ evidenceRefs: ['task://b'], subtasks: [{ evidenceRefs: ['task://c'] }] }],
    runTrace: { events: [{ evidenceRefs: ['trace://d'] }] },
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'claim://e' }],
  });
  assert.deepEqual([...refs].sort(), ['plan://a', 'task://b', 'task://c', 'trace://d']);
});

test('assertAcceptanceCloseGate throws a typed error', () => {
  assert.throws(
    () => assertAcceptanceCloseGate({
      successCriteria: [criterion('c1', '缺证据')],
    }),
    (error: unknown) => error instanceof AcceptanceCloseGateError && error.code === 'acceptance_evidence_incomplete',
  );
});

test('isAcceptanceClosePatch only fires when acceptance is newly written', () => {
  assert.equal(isAcceptanceClosePatch(undefined, { acceptedAt: '2026-08-22T00:00:00.000Z' }), true);
  assert.equal(isAcceptanceClosePatch({ acceptedAt: '2026-08-22T00:00:00.000Z' }, { acceptedAt: '2026-08-22T00:00:00.000Z' }), false);
  assert.equal(isAcceptanceClosePatch({ acceptedAt: '2026-08-22T00:00:00.000Z' }, undefined), false);
});
