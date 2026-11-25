import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionVerificationDetail } from '@peer-agent/protocol';
import { gateDeliveryDetail, verdictBannerTitle } from './verdictBanner.ts';

const check = (name: string, reason?: string) => ({ name, result: 'passed' as const, reason, evidenceRefs: [] });
const verification = (
  outcome: SessionVerificationDetail['outcome'],
  checks: SessionVerificationDetail['checks'],
): SessionVerificationDetail => ({ outcome, checks }) as unknown as SessionVerificationDetail;
const gateDelivered = verification('passed', [
  check('leaf_evidence'),
  check('independent_verifier', 'not_required'),
  { ...check('model_review', 'not_reviewed'), result: 'failed' },
]);

test('a review the task did not need is titled as such and never as a passed review', () => {
  for (const isZh of [true, false]) {
    const title = verdictBannerTitle(gateDelivered, 0, isZh);
    assert.equal(title, isZh ? '无需独立核验' : 'No independent verification required');
    assert.ok(!title.includes('核验通过'), title);
    assert.ok(!/verification passed/i.test(title), title);
  }
  assert.equal(
    gateDeliveryDetail(gateDelivered, true),
    '结果按证据闸门交付，未做独立核验。任务说明中的质量标准未经独立核验。',
  );
  assert.equal(
    gateDeliveryDetail(gateDelivered, false),
    'Delivered on the evidence gate; no independent verification was run. Quality criteria in the task brief were not independently reviewed.',
  );
  assert.equal(
    gateDeliveryDetail(verification('passed', [check('leaf_evidence'), check('independent_verifier', 'not_required')]), true),
    '结果按证据闸门交付，未做独立核验。',
    'a task without quality criteria does not mention any',
  );
});

test('a real review and the other outcomes keep their wording', () => {
  const reviewed = verification('passed', [check('leaf_evidence'), check('independent_verifier')]);
  assert.equal(verdictBannerTitle(reviewed, 1, true), '独立只读核验通过');
  assert.equal(verdictBannerTitle(reviewed, 1, false), 'Independent verification passed');
  assert.equal(gateDeliveryDetail(reviewed, true), '');

  // A failed review on such a task keeps its failure title and says nothing about the gate.
  const failed = verification('failed', [{ ...check('independent_verifier', 'failed'), result: 'failed' }]);
  assert.equal(verdictBannerTitle(failed, 3, true), '独立核验未通过（已完成 3/3 次）');
  assert.equal(verdictBannerTitle(failed, 4, false), 'Verification failed (3/3)');
  assert.equal(gateDeliveryDetail(failed, true), '');

  assert.equal(verdictBannerTitle(verification('failed', []), 0, true), '独立核验未通过');
  assert.equal(verdictBannerTitle(verification('failed', []), 0, false), 'Verification failed');
  assert.equal(verdictBannerTitle(verification('partial', []), 0, true), '独立核验进行中或部分完成');
  assert.equal(verdictBannerTitle(verification('partial', []), 0, false), 'Verification in progress');
});
