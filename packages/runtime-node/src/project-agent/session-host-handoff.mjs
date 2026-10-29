/** Handoff suspension is distinct from a user's pause or a pending decision. */
export function shouldPauseForHostHandoff(plan) {
  return plan?.delegationOrigin?.phase === 'running'
    && ['accepted', 'executing', 'interrupted'].includes(plan.status)
    && ['running', 'exploring', 'verifying'].includes(plan.runner?.status);
}

export function isHostHandoffPause(plan) {
  return plan?.status === 'paused' && plan.runner?.status === 'paused'
    && plan.runner.blockedReason === 'host_handoff'
    && plan.delegationOrigin?.phase === 'paused'
    && plan.delegationOrigin.pausedFromPhase === 'running';
}
