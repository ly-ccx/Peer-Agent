import { createHash } from 'node:crypto';

/** Bind a host recheck to its work, not transient verifying flags or counters. */
export function verificationContentHash(plan, report = '') {
  return createHash('sha256').update(JSON.stringify([
    plan?.planId, plan?.goal, plan?.tasks, plan?.successCriteria, plan?.criterionResults,
    plan?.manualConfirmations, plan?.deliveryBinding, report,
  ])).digest('hex');
}

/** Resolve an unchanged idle verification blocker, never replay its completed worker. */
export function canCompleteAfterRecheck({ plan, contentHash, currentHash, gate, active = false }) {
  const verifierBlocked = plan?.status === 'executing' && plan.runner?.status === 'blocked'
    && (plan.runner.blockerAudit?.reason === 'verifier_failed'
      || plan.runner.blockerAudit?.reason === 'verification_gate_failed'
      || plan.runner.blockedReason?.startsWith('Verifier failed:')
      || plan.runner.blockedReason?.startsWith('Verification gate failed:'));
  // A verifier exception can leave completed worker facts with a failed runner.
  // Fresh, version-bound host verification and the full gate must still pass.
  const completedAttemptFailed = plan?.status === 'completed' && plan.runner?.status === 'failed';
  const completeLeaves = nodes => Array.isArray(nodes) && nodes.length > 0 && nodes.every(node =>
    node.subtasks?.length ? completeLeaves(node.subtasks) : node.status === 'completed');
  return Boolean(plan?.delegationOrigin?.phase === 'running' && !plan.delegationOrigin.supersededBy
    && !plan.delegationOrigin.cancellation && plan.runner?.waitingOnUser !== true && completeLeaves(plan.tasks)
    && (verifierBlocked || completedAttemptFailed) && !active
    && plan.hostVerification?.independentVerifier === 'passed'
    && contentHash && contentHash === plan.hostVerification.contentHash
    && contentHash === currentHash && gate?.passed === true);
}
