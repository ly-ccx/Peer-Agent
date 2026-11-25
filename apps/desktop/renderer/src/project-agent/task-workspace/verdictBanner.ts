import type { SessionVerificationDetail } from '@peer-agent/protocol';

function hasReason(verification: SessionVerificationDetail, name: string, reason: string): boolean {
  return verification.checks.some((check) => check.name === name && check.reason === reason);
}

/**
 * The banner titles what the host concluded. A session whose evidence the
 * independent verifier cannot read is delivered on the evidence gate; it must
 * never read as a passed review.
 */
export function verdictBannerTitle(
  verification: SessionVerificationDetail,
  attemptCount: number,
  isZh: boolean,
): string {
  const attempts = Math.min(attemptCount, 3);
  if (verification.outcome === 'passed') {
    return hasReason(verification, 'independent_verifier', 'not_required')
      ? (isZh ? '无需独立核验' : 'No independent verification required')
      : (isZh ? '独立只读核验通过' : 'Independent verification passed');
  }
  if (verification.outcome === 'failed') {
    return isZh
      ? `独立核验未通过${attemptCount > 0 ? `（已完成 ${attempts}/3 次）` : ''}`
      : `Verification failed${attemptCount > 0 ? ` (${attempts}/3)` : ''}`;
  }
  return isZh ? '独立核验进行中或部分完成' : 'Verification in progress';
}

/** Stated under the title: which parts were not independently verified. Empty unless the gate delivered the result. */
export function gateDeliveryDetail(verification: SessionVerificationDetail, isZh: boolean): string {
  if (verification.outcome !== 'passed'
    || !hasReason(verification, 'independent_verifier', 'not_required')) return '';
  const qualityNotReviewed = hasReason(verification, 'model_review', 'not_reviewed');
  return isZh
    ? `结果按证据闸门交付，未做独立核验。${qualityNotReviewed ? '任务说明中的质量标准未经独立核验。' : ''}`
    : `Delivered on the evidence gate; no independent verification was run.${qualityNotReviewed ? ' Quality criteria in the task brief were not independently reviewed.' : ''}`;
}
