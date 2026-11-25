import type { SessionVerificationDetail } from '@peer-agent/protocol';

export type VerdictStrip = { label: string; tone: 'good' | 'danger' | undefined };

/**
 * The strip button titles what the host concluded. A session whose evidence the
 * independent verifier cannot read was delivered on the evidence gate; it is
 * titled as not requiring a review and never as verified.
 */
export function verdictStrip(verification: SessionVerificationDetail, isZh: boolean): VerdictStrip {
  if (verification.checks.some((check) => check.name === 'independent_verifier' && check.reason === 'not_required')) {
    return { label: isZh ? '无需核验' : 'Not required', tone: undefined };
  }
  if (verification.outcome === 'passed') return { label: isZh ? '核验通过' : 'Verified', tone: 'good' };
  if (verification.outcome === 'failed') return { label: isZh ? '核验未通过' : 'Verdict failed', tone: 'danger' };
  return { label: isZh ? '核验中' : 'Verifying', tone: undefined };
}
