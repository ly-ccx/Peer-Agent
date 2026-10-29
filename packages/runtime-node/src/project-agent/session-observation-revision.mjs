import { createHash } from 'node:crypto';

/** Verification source identity and a changed failure observation are different facts. */
export function sessionObservationRevision(plan, sourceRevision) {
  const run = plan?.runner?.verifierRuns?.at(-1);
  const observation = { sourceRevision, blockedReason: plan?.runner?.blockedReason || '', lastError: plan?.runner?.lastError || '',
    review: run && ['passed', 'failed'].includes(run.status) ? { status: run.status, summary: run.summary, failureReason: run.failureReason,
      failedCriteria: run.report?.failedCriteria, missingEvidence: run.report?.missingEvidence, risks: run.report?.risks,
      nextAction: run.report?.recommendedNextAction } : null };
  const stable = JSON.stringify(observation).replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/provider_trace=[^\s"\\]+/g, 'provider_trace=<ref>');
  return createHash('sha256').update(stable).digest('hex');
}

export function sameSessionObservation(left, right) {
  return left.sessionId === right.sessionId && left.sourceRevision === right.sourceRevision && left.status === right.status
    && left.observationRevision === right.observationRevision;
}
