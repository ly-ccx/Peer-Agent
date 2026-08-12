function reportGoalPlanChangeError(error) {
  try {
    console.warn('[task-notification] external goal plan change failed:', error);
  } catch {
    // Packaged Electron instances can outlive the parent stdio pipe that launched
    // them. Error reporting must never turn a handled notification failure into
    // an uncaught EPIPE in the main process.
  }
}

export function bindExternalGoalPlanChanges({
  goalPlanStore,
  broadcast,
  getTaskNotificationBroker = () => null,
  currentPid = process.pid,
  onError = reportGoalPlanChangeError,
}) {
  if (!goalPlanStore || typeof goalPlanStore.subscribeChanges !== 'function') return () => {};
  return goalPlanStore.subscribeChanges((event) => {
    if (!event || event.writerPid === currentPid) return;
    const payload = {
      reason: event.reason ?? 'external-persist',
      planId: event.planId ?? null,
      conversationId: event.conversationId ?? null,
      changeKind: event.changeKind ?? 'persist',
      ...(event.runner ? { runner: event.runner } : {}),
    };
    broadcast('goalPlans:changed', payload);
    try {
      getTaskNotificationBroker()?.handleGoalPlanChanged?.(payload);
    } catch (error) {
      onError(error);
    }
  });
}
