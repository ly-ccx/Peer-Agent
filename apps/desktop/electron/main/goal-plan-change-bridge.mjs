export function bindExternalGoalPlanChanges({
  goalPlanStore,
  broadcast,
  getTaskNotificationBroker = () => null,
  currentPid = process.pid,
  onError = (error) => console.warn('[task-notification] external goal plan change failed:', error),
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
