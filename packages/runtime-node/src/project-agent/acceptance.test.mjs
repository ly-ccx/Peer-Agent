import assert from 'node:assert/strict';
import test from 'node:test';

import { decideSessionAcceptance } from './acceptance.mjs';

function passingPlan(extra = {}) {
  return {
    verificationOutcome: 'passed',
    runner: { verifierRuns: [{ outcome: 'passed', note: 'model says this passed' }] },
    tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: ['ev-1'] }],
    successCriteria: [{ id: 'c1', kind: 'test', description: '测试通过' }],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'ev-1' }],
    ...extra,
  };
}

function facts(extra = {}) {
  return {
    plan: passingPlan(),
    sessionId: 'sess-1',
    policy: 'auto',
    reported: true,
    readOnly: false,
    evidenceIndex: ['ev-1'],
    ...extra,
  };
}

test('结论不是 passed 时需要确认，模型自述不能代签', () => {
  const decision = decideSessionAcceptance(facts({
    plan: passingPlan({
      tasks: [{ taskId: 'leaf', status: 'completed', evidenceRefs: ['model-ref'] }],
      criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'model-ref' }],
    }),
    evidenceIndex: [],
    userAgreed: true,
    acceptedBy: 'user',
    userOverride: { accept: true },
  }));
  assert.notEqual(decision.verdict.outcome, 'passed');
  assert.equal(decision.reasons.includes('verdict_not_passed'), true);
  assert.equal(decision.mode, 'confirm');
  assert.equal(decision.acceptedBy, undefined);
});

test('非只读任务改动超过 20 个文件时需要确认，只读和刚好 20 个不触发', () => {
  const many = Array.from({ length: 21 }, (_, index) => `file-${index}.js`);
  const over = decideSessionAcceptance(facts({ changedFiles: [...many, many[0]] }));
  assert.equal(over.reasons.includes('changed_files_over_limit'), true);
  assert.equal(over.mode, 'confirm');
  assert.equal(over.acceptedBy, undefined);

  const exact = decideSessionAcceptance(facts({
    changedFiles: Array.from({ length: 20 }, (_, index) => `file-${index}.js`),
  }));
  assert.equal(exact.reasons.includes('changed_files_over_limit'), false);
  assert.equal(exact.acceptedBy, 'policy');

  const readOnly = decideSessionAcceptance(facts({ readOnly: true, changedFiles: many }));
  assert.equal(readOnly.reasons.includes('changed_files_over_limit'), false);
  assert.equal(readOnly.acceptedBy, 'policy');
});

test('不可逆操作、锚点要求确认、项目策略为 confirm 都需要确认', () => {
  const irreversible = decideSessionAcceptance(facts({ irreversible: true }));
  assert.deepEqual(irreversible.reasons, ['destructive_operation']);
  assert.equal(irreversible.acceptedBy, undefined);

  const anchor = decideSessionAcceptance(facts({ anchorText: '做好之后先让我确认' }));
  assert.equal(anchor.reasons.includes('user_requested_review'), true);
  assert.equal(anchor.acceptedBy, undefined);

  const project = decideSessionAcceptance(facts({ policy: 'confirm' }));
  assert.equal(project.reasons.includes('project_requires_confirm'), true);
  assert.equal(project.acceptedBy, undefined);
});

test('回复之前不代签；外部副作用仍然需要确认', () => {
  const unreported = decideSessionAcceptance(facts({ reported: false }));
  assert.equal(unreported.mode, 'auto');
  assert.equal(unreported.acceptedBy, undefined);

  const sideEffect = decideSessionAcceptance(facts({ externalSideEffects: true }));
  assert.equal(sideEffect.reasons.includes('external_side_effects'), true);
  assert.equal(sideEffect.acceptedBy, undefined);
});

test('用户确认路径写 acceptedBy user，模型参数不能走这条路径', () => {
  const forged = decideSessionAcceptance(facts({
    policy: 'confirm',
    userAgreed: true,
    acceptedBy: 'user',
    userOverride: { accept: true },
  }));
  assert.equal(forged.acceptedBy, undefined);

  const confirmed = decideSessionAcceptance(facts({ policy: 'confirm' }), { userConfirm: true });
  assert.equal(confirmed.acceptedBy, 'user');
  assert.equal(confirmed.mode, 'confirm');
  assert.equal(confirmed.verdictRef, 'verdict:sess-1:passed');
  assert.equal(confirmed.closeGatePassed, true);
});
