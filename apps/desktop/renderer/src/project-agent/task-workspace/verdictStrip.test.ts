import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionVerificationDetail } from '@peer-agent/protocol';
import { verdictStrip } from './verdictStrip.ts';

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

test('a review the task did not need is titled as such, without the verified tone', () => {
  assert.deepEqual(verdictStrip(gateDelivered, true), { label: '无需核验', tone: undefined });
  assert.deepEqual(verdictStrip(gateDelivered, false), { label: 'Not required', tone: undefined });
});

test('a real review and the other outcomes keep their title and tone', () => {
  const reviewed = verification('passed', [check('leaf_evidence'), check('independent_verifier')]);
  assert.deepEqual(verdictStrip(reviewed, true), { label: '核验通过', tone: 'good' });
  assert.deepEqual(verdictStrip(reviewed, false), { label: 'Verified', tone: 'good' });

  // A failed review on such a task keeps its failure title.
  const failed = verification('failed', [{ ...check('independent_verifier', 'failed'), result: 'failed' }]);
  assert.deepEqual(verdictStrip(failed, true), { label: '核验未通过', tone: 'danger' });
  assert.deepEqual(verdictStrip(verification('failed', []), false), { label: 'Verdict failed', tone: 'danger' });

  assert.deepEqual(verdictStrip(verification('partial', []), true), { label: '核验中', tone: undefined });
  assert.deepEqual(verdictStrip(verification('partial', []), false), { label: 'Verifying', tone: undefined });
});
