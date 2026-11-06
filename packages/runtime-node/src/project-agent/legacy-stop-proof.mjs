/** Adapt the old host's post-idle cancellation commit, never a bare completion flag. */
export function legacyCancellationStopped(plan) {
  const origin = plan?.delegationOrigin, cancellation = origin?.cancellation;
  if (cancellation?.phase !== 'completed' || origin.executionGeneration) return false;
  const requested = Date.parse(cancellation.requestedAt), completed = Date.parse(cancellation.completedAt);
  if (!Number.isFinite(requested) || !Number.isFinite(completed) || completed < requested) return false;
  const revisions = plan.revisionHistory || [];
  const index = revisions.findLastIndex(row => row.changedBy === 'session-cancellation'
    && row.changedAt === cancellation.completedAt && row.reason === cancellation.reason);
  if (index < 0) return false;
  // A later admission, takeover, revision or unclassified writer invalidates this legacy proof.
  return revisions.slice(index + 1).every(row => row.changedBy === 'session-control' || row.changedBy === 'goal-runner' && row.reason === 'delegated runner paused'
    || row.changedBy === 'session-cancellation' && row.reason === 'cancellation cleanup settled');
}

/** A legacy takeover can interrupt an already idle worker/verifier before any new dispatch. */
export function legacyTakeoverIdle(plan) {
  const origin = plan?.delegationOrigin, takeover = origin?.takeover;
  if (takeover?.phase !== 'stopping' || origin.cancellation || origin.executionGeneration) return false;
  const revisions = plan.revisionHistory || [];
  const index = revisions.findLastIndex(row => row.changedBy === 'session-takeover'
    && row.reason === 'coordinator executor takeover' && row.changedAt === takeover.requestedAt);
  if (index < 0 || !revisions.slice(index + 1).every(row => row.changedBy === 'session-control'
    || row.changedBy === 'goal-runner' && row.reason === 'delegated runner paused')) return false;
  const events = plan.runTrace?.events || [];
  const start = events.findLastIndex(row => row.goalPlanId === plan.planId && row.type === 'step_started'
    && row.payload?.summaryCode === 'turn_started');
  if (start < 0) return false;
  const finish = events.findIndex((row, i) => i > start && row.goalPlanId === plan.planId && row.type === 'step_completed'
    && row.payload?.summaryCode === 'turn_completed' && row.payload.turnNumber === events[start].payload.turnNumber
    && row.payload.terminalStatus === 'done');
  if (finish < 0) return false;
  const verification = revisions.findLastIndex(row => row.changedBy === 'session-verification');
  return verification >= 0 && verification < index && revisions[verification].reason === 'verification verdict'
    && Date.parse(revisions[verification].changedAt) >= Date.parse(events[finish].createdAt)
    && Date.parse(takeover.requestedAt) >= Date.parse(revisions[verification].changedAt)
    && !events.slice(finish + 1).some(row => row.type === 'step_started' || row.type === 'action_started');
}
