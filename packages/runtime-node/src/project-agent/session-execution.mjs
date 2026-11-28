import { sessionFactsFromPlan } from './session-facts.mjs';

const ENDED = new Set(['accepted', 'result_ready', 'completed', 'failed', 'cancelled', 'verification_failed', 'superseded']);

function executionEnded(plan) {
  if (!plan?.delegationOrigin) return false;
  const { status, verificationActive } = sessionFactsFromPlan(plan);
  return ENDED.has(status) || (!verificationActive && (
    plan.delegationOrigin.independentVerifier === 'failed' || plan.verificationReport?.passed === false
  ));
}

// Deliberately independent of goal-plan timing: plan approval and queue writes are not worker starts.
export function advanceSessionExecution(plan, previous, at = new Date().toISOString()) {
  if (!plan.delegationOrigin) return undefined;
  let startedAt = previous?.sessionExecution?.startedAt || plan.sessionExecution?.startedAt;
  let endedAt = previous?.sessionExecution?.endedAt || plan.sessionExecution?.endedAt;
  if (!startedAt && previous?.delegationOrigin && plan.delegationOrigin.phase === 'running' && previous?.delegationOrigin?.phase !== 'running') {
    startedAt = at;
  }
  // An imported terminal plan has no observed transition to timestamp.
  if (!endedAt && previous?.delegationOrigin && executionEnded(plan) && !executionEnded(previous)) {
    endedAt = at;
  }
  return startedAt || endedAt ? { ...(startedAt ? { startedAt } : {}), ...(endedAt ? { endedAt } : {}) } : undefined;
}
