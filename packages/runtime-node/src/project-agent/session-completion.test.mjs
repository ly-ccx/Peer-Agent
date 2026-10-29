import assert from 'node:assert/strict';
import test from 'node:test';
import { projectCompletionReview, confirmCompletionReview, resultCanBeAccepted } from './session-completion.mjs';

function fixture() {
  const plan = { planId: 'p', status: 'executing', delegationOrigin: { sessionId: 's', phase: 'running' },
    runner: { enabled: true, status: 'blocked', blockedReason: 'manual_dod_confirmation_required' },
    successCriteria: [{ id: 'c1', kind: 'manual', description: '报告覆盖四项具体发现' }],
    criterionResults: [{ criterionId: 'c1', passed: true, evidenceRef: 'ev' }],
    tasks: [{ taskId: 'leaf', status: 'completed', result: '实际报告' }], manualConfirmations: [] };
  let resumed = 0, failResume = false, failPersist = false;
  const store = { getPlan: () => plan, recordManualConfirmation(_id, row) {
    if (failPersist) throw Error('cannot persist'); plan.manualConfirmations.push(row);
  } };
  const runner = { async resume(_id, options) {
    assert.equal(options.intent, 'verify');
    if (failResume) throw Error('cannot resume'); resumed++; plan.runner.status = 'verifying';
  } };
  const report = { summary: '根目录、规则、脚本、提交核对的实际报告' };
  const review = () => projectCompletionReview(plan, report);
  return { plan, store, runner, report, review, count: () => resumed,
    setFailure: (kind, value) => { if (kind === 'persist') failPersist = value; else failResume = value; } };
}

test('completion review is distinct from result acceptance and is bound to report and criteria', async () => {
  const f = fixture(), review = f.review();
  assert.equal(resultCanBeAccepted(f.plan), false);
  assert.equal(review.criteria[0].description, '报告覆盖四项具体发现');
  f.report.summary += ' new'; assert.notEqual(f.review().reviewToken, review.reviewToken);
  const rejected = await confirmCompletionReview({ ...f, review: f.review(), reviewToken: review.reviewToken, now: () => 'now' });
  assert.equal(rejected.error, 'stale_completion_review'); assert.equal(f.count(), 0);
  assert.equal(f.plan.manualConfirmations.length, 0);
  for (const status of ['running', 'verifying', 'completed', 'failed']) {
    f.plan.runner.status = status; assert.equal(f.review(), null);
  }
  f.plan.status = 'completed'; f.plan.runner = { enabled: true, status: 'verifying' };
  assert.equal(resultCanBeAccepted(f.plan), false);
  f.plan.runner.status = 'completed'; assert.equal(resultCanBeAccepted(f.plan), true);
});

test('only explicit local review writes manual confirmation, then verification resumes once', async () => {
  const f = fixture(), review = f.review();
  const input = { ...f, review, reviewToken: review.reviewToken, now: () => '2026-10-06T00:00:00Z' };
  assert.equal((await confirmCompletionReview(input)).ok, true);
  assert.deepEqual(f.plan.manualConfirmations[0].criterionIds, ['c1']);
  assert.equal(f.plan.manualConfirmations[0].decidedBy, 'local_ui');
  assert.equal(f.plan.resultAcceptance, undefined); assert.equal(f.count(), 1);
  assert.equal((await confirmCompletionReview({ ...input, review: null })).alreadyConfirmed, true);
  assert.equal(f.count(), 1); assert.equal(f.plan.manualConfirmations.length, 1);
});

test('a temporarily completed leaf projection still permits manual review, but old approval cannot cover a changed report', async () => {
  const f = fixture(); f.plan.status = 'completed';
  const review = f.review(); assert.ok(review); assert.equal(resultCanBeAccepted(f.plan), false);
  const input = { ...f, review, reviewToken: review.reviewToken, now: () => 'now' };
  f.setFailure('resume', true); await assert.rejects(confirmCompletionReview(input));
  f.report.summary += ' changed'; f.setFailure('resume', false);
  assert.equal((await confirmCompletionReview({ ...input, review: null })).error, 'stale_completion_review');
  assert.equal(f.count(), 0);
  f.report.summary = '根目录、规则、脚本、提交核对的实际报告';
  f.plan.delegationOrigin.phase = 'superseded';
  assert.equal((await confirmCompletionReview({ ...input, review: null })).alreadyConfirmed, true);
  assert.equal(f.count(), 0);
});

test('a later manual rejection invalidates the old review while permitting a fresh explicit decision', async () => {
  const f = fixture(), review = f.review(); f.setFailure('resume', true);
  const input = { ...f, review, reviewToken: review.reviewToken, now: () => 'now' };
  await assert.rejects(confirmCompletionReview(input));
  f.plan.manualConfirmations.push({ confirmationId: 'later', criterionIds: ['c1'], decision: 'reject', decidedBy: 'local_ui' });
  assert.equal((await confirmCompletionReview(input)).error, 'stale_completion_review');
  const fresh = f.review(); assert.notEqual(fresh.reviewToken, review.reviewToken); assert.equal(fresh.confirmed, undefined);
  f.setFailure('resume', false);
  assert.equal((await confirmCompletionReview({ ...input, review: fresh, reviewToken: fresh.reviewToken })).ok, true);
  assert.equal(f.count(), 1);
});

test('write failure cannot resume; retry after resume failure does not forge a second approval', async () => {
  const f = fixture(), review = f.review();
  const input = { ...f, review, reviewToken: review.reviewToken, now: () => 'now' };
  f.setFailure('persist', true); await assert.rejects(confirmCompletionReview(input));
  assert.equal(f.count(), 0); assert.equal(f.plan.manualConfirmations.length, 0);
  f.setFailure('persist', false); f.setFailure('resume', true);
  await assert.rejects(confirmCompletionReview(input)); assert.equal(f.plan.manualConfirmations.length, 1);
  assert.equal(f.review().confirmed, true, 'a failed resume retains a visible retry without another manual decision');
  f.setFailure('resume', false); await confirmCompletionReview({ ...input, review: null });
  assert.equal(f.count(), 1); assert.equal(f.plan.manualConfirmations.length, 1);
});
