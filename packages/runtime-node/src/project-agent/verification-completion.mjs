import { createHash } from 'node:crypto';

/** Bind a host recheck to its work, not transient verifying flags or counters. */
export function verificationContentHash(plan, report = '') {
  return createHash('sha256').update(JSON.stringify([
    plan?.planId, plan?.goal, plan?.tasks, plan?.successCriteria, plan?.criterionResults,
    plan?.manualConfirmations, plan?.deliveryBinding, report,
  ])).digest('hex');
}

/** A passing recheck can resolve only an unchanged, idle readonly verifier failure. */
export function canCompleteAfterRecheck({ plan, contentHash, currentHash, gate, active = false }) {
  const verifierBlocked = plan?.status === 'executing' && plan.runner?.status === 'blocked'
    && (plan.runner.blockerAudit?.reason === 'verifier_failed'
      || plan.runner.blockedReason?.startsWith('Verifier failed:'));
  // A verifier exception can leave completed worker facts with a failed runner.
  // Fresh, version-bound host verification and the full gate must still pass.
  const completedAttemptFailed = plan?.status === 'completed' && plan.runner?.status === 'failed';
  return Boolean(plan?.delegationOrigin?.readOnly === true && plan.delegationOrigin.phase === 'running'
    && (verifierBlocked || completedAttemptFailed) && !active
    && plan.hostVerification?.independentVerifier === 'passed'
    && contentHash && contentHash === plan.hostVerification.contentHash
    && contentHash === currentHash && gate?.passed === true
    && gate.uiDeliveryRequired !== true);
}
