import { createCoordinationRecoveryService, shouldPauseForHostHandoff, executionOwnershipOf } from '@peer-agent/runtime-node';

/** Desktop supplies existing execution/lease ports; the portable service owns maintenance. */
export function createDesktopRecoveryController({ rootDir, host, hostLeases, holdsLease, readLeaseEpoch,
  supervisor, goalPlanStore, goalRunner, agentTurnExecutor, objectiveWatches, executionScheduler, changed } = {}) {
  const plans = id => supervisor.sessionsForProject(id).map(row => goalPlanStore.getPlan(row.planId)).filter(Boolean);
  const terminal = plan => executionOwnershipOf(plan) !== 'live' && (
    plan.status === 'completed' && (!plan.runner?.enabled || plan.runner.status === 'completed')
    || plan.status === 'failed' && plan.runner?.status === 'failed'
    || plan.status === 'cancelled' && (!plan.runner?.enabled || plan.runner.status === 'cancelled'
      || plan.delegationOrigin?.cancellation?.phase === 'completed' && !plan.delegationOrigin.cancellation.cleanupPending));
  const epoch = id => readLeaseEpoch?.(id) ?? (() => {
    const lease = hostLeases?.diagnosticSnapshot(id);
    return lease ? `${lease.hostId}:${lease.acquiredAt}` : null;
  })();
  return createCoordinationRecoveryService({ rootDir, holdsLease, leaseEpoch: epoch,
    isReady: id => host.isReady(id),
    readLease: id => hostLeases?.diagnosticSnapshot(id),
    sessionInventory: id => plans(id).map(plan => ({ sessionId: plan.delegationOrigin.sessionId, title: plan.title,
      terminal: terminal(plan) && !plan.deliveryBinding?.worktreePath && (plan.status !== 'completed' || Boolean(plan.resultAcceptance?.acceptedAt)) })),
    sessionSafe: (id, sessionId) => plans(id).some(plan => plan.delegationOrigin.sessionId === sessionId && ['completed', 'cancelled'].includes(plan.status) && terminal(plan)),
    titleForWork: (id, work) => plans(id).find(plan => work.sessionIds?.includes(plan.delegationOrigin.sessionId))?.title,
    onChanged: changed,
    async quiesce(id) {
      host.beginMaintenance(id);
      const sessions = plans(id);
      if (sessions.some(plan => !terminal(plan)) && typeof goalRunner?.waitForIdle !== 'function') throw new Error('coordination_recovery_stop_unavailable');
      for (const plan of sessions) if (shouldPauseForHostHandoff(plan)) goalRunner.pause(plan.planId, 'host_handoff');
      await agentTurnExecutor.stop?.(id);
      await objectiveWatches.stopWorkspace(id);
      await host.waitForIdle(id);
      await supervisor.waitForCoordinationIdle(id);
      await Promise.all(sessions.map(async plan => {
        await goalRunner?.waitForIdle?.(plan.planId);
        await executionScheduler.waitForPlanIdle(plan.planId);
      }));
    },
    async cancelSessions(id, ids) {
      for (const sessionId of ids) {
        let plan = plans(id).find(row => row.delegationOrigin.sessionId === sessionId);
        if (!plan) throw new Error('coordination_recovery_session_changed');
        plan = goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin, retainedForRecovery: true } },
          { reason: 'preserve historical results', changedBy: 'local_ui' });
        if (terminal(plan)) continue;
        const result = await supervisor.cancel({ sessionId, reason: 'recovery_retained', preserveArtifacts: true, promote: false });
        if (!result || result.error || result.cancellationPending || result.status !== 'cancelled') throw new Error('coordination_recovery_stop_failed');
      }
    },
    restart(id) {
      host.endMaintenance(id);
      // The command returns the durable admission receipt; the existing host then
      // consumes queued inputs. It does not wait for a model's full response.
      queueMicrotask(() => { void host.restart(id).catch(() => changed(id)); });
    },
  });
}
