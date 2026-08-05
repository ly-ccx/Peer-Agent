const FAILURE_STATUSES = new Set(['failed', 'timed_out', 'blocked']);
const ATTENTION_STATUSES = new Set(['waiting_permission', 'waiting_user', 'failed', 'timed_out', 'blocked']);

export function automationOutcomeDecision(definition, run) {
  const failed = FAILURE_STATUSES.has(run.status);
  const nextFailures = run.status === 'succeeded'
    ? 0
    : failed ? (definition.consecutiveFailures ?? 0) + 1 : (definition.consecutiveFailures ?? 0);
  const autoPause = failed && nextFailures >= 3;
  const notify = ATTENTION_STATUSES.has(run.status)
    || (run.status === 'succeeded' && definition.notifications?.succeeded === true);
  return Object.freeze({ failed, nextFailures, autoPause, notify });
}

export function createAutomationOutcomeController({
  store,
  createNotification,
  openRun,
  logger = console,
}) {
  if (!store) throw new TypeError('store is required');

  function handleRunUpdated(run) {
    const definition = store.getDefinition(run.automationId);
    if (!definition) return null;
    const decision = automationOutcomeDecision(definition, run);
    if (run.status === 'succeeded' || decision.failed) {
      store.updateDefinitionRuntimeFacts(definition.automationId, {
        consecutiveFailures: decision.nextFailures,
        ...(decision.autoPause ? { status: 'paused', pauseReason: 'consecutive_failures' } : {}),
      });
    }
    if (!decision.notify || typeof createNotification !== 'function') return decision;
    const title = run.status === 'succeeded'
      ? `${definition.name} completed`
      : run.status === 'waiting_user' || run.status === 'waiting_permission'
        ? `${definition.name} needs attention`
        : `${definition.name} failed`;
    const detail = run.receipt?.summary || run.receipt?.error || run.failureReason || run.blockedReason
      || (decision.autoPause ? 'Paused after three consecutive failures.' : `Run ${run.status.replaceAll('_', ' ')}.`);
    try {
      const notification = createNotification({ title, body: String(detail).slice(0, 240), silent: false });
      notification?.on?.('click', () => openRun?.({
        automationId: run.automationId,
        runId: run.runId,
        conversationId: run.conversationId,
      }));
      notification?.show?.();
    } catch (error) {
      logger?.warn?.('[automation-notification] show failed', error);
    }
    return decision;
  }

  return Object.freeze({ handleRunUpdated });
}
