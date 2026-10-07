import { deriveSessionFacts } from '@peer-agent/protocol';

// Execution ownership is process-local. A stale persisted flag cannot prove a live verifier after restart.
const attempts = new Map();
export function beginVerificationAttempt(planId, attemptId) {
  const token = { attemptId };
  const active = attempts.get(planId) || new Set();
  active.add(token); attempts.set(planId, active);
  return () => {
    active.delete(token);
    if (!active.size && attempts.get(planId) === active) attempts.delete(planId);
  };
}
export function sessionFactsFromPlan(plan) {
  const verificationActive = attempts.has(plan?.planId);
  return { ...deriveSessionFacts({ status: plan?.status, runnerStatus: plan?.runner?.status,
    phase: plan?.delegationOrigin?.phase, superseded: Boolean(plan?.delegationOrigin?.supersededBy),
    accepted: Boolean(plan?.resultAcceptance?.acceptedAt),
    needsUser: plan?.delegationOrigin?.phase === 'awaiting_approval',
    blockedReason: plan?.runner?.blockedReason,
    verificationActive,
  }), verificationActive };
}
