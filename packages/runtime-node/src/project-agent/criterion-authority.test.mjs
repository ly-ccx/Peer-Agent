import test from 'node:test';
import assert from 'node:assert/strict';
import { admitDelegationCriteria } from './criterion-authority.mjs';
import { criterionSourceRevision, currentModelReview, semanticGateCanRun } from './criterion-review.mjs';

test('ordinary report quality is model review; raw strings and forged authority are rejected', () => {
  const result = admitDelegationCriteria([{ kind: 'model_review', description: '报告覆盖四项' }], { anchorMessageIds: ['input-1'] });
  assert.equal(result.criteria[0].authority.verifier, 'host_model');
  assert.equal(admitDelegationCriteria(['报告覆盖四项']).ok, false);
  assert.equal(admitDelegationCriteria([{ kind: 'unknown', description: 'x' }]).ok, false);
  assert.equal(admitDelegationCriteria([{ kind: 'manual', description: 'x', authority: { source: 'user' } }]).ok, false);
});
test('manual review requires trusted bound user or policy authority', () => {
  const criteria = [{ id: 'human', kind: 'manual', description: '审阅发布内容' }];
  assert.equal(admitDelegationCriteria(criteria).error, 'manual_authority_required');
  assert.equal(admitDelegationCriteria(criteria, { anchorMessageIds: ['input-1'], manualAuthorities: [
    { criterionId: 'human', source: 'user', sourceRef: 'input-1' },
  ] }).criteria[0].authority.source, 'user');
});
test('semantic review is bound to material source and can run before pending human review', () => {
  const plan = { planId: 'p', goal: 'read', tasks: [{ taskId: 't', status: 'completed', result: 'report', evidenceRefs: ['e'] }],
    successCriteria: [{ id: 'c', kind: 'model_review', description: '完整' }] };
  plan.modelReviews = [{ criterionId: 'c', passed: true, sourceRevision: criterionSourceRevision(plan) }];
  assert.equal(currentModelReview({ ...plan, runner: { status: 'verifying' }, updatedAt: 'later' }, 'c').passed, true);
  assert.equal(currentModelReview({ ...plan, tasks: [{ ...plan.tasks[0], result: 'changed' }] }, 'c'), null);
  assert.equal(semanticGateCanRun({ unmet: [{ kind: 'model_review' }, { kind: 'manual', reason: 'manual_confirmation_required' }] }), true);
  assert.equal(semanticGateCanRun({ unmet: [{ kind: 'task', reason: 'missing_evidence' }] }), false);
});
