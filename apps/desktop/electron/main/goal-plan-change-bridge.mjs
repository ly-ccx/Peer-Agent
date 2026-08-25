/**
 * Desktop 订阅共享 goal-plan store 的跨进程变更。
 *
 * CLI/TUI 写 .changes.jsonl 时，这里转成 goalPlans:changed。
 * runner-progress 是高频软进度：合并节流后再广播，避免整窗跟着抖。
 * 硬状态变更（persist/delete/…）仍立即广播。
 */

function reportGoalPlanChangeError(error) {
  try {
    console.warn('[task-notification] external goal plan change failed:', error);
  } catch {
    // Packaged Electron instances can outlive the parent stdio pipe that launched
    // them. Error reporting must never turn a handled notification failure into
    // an uncaught EPIPE in the main process.
  }
}

function isSoftRunnerProgress(event) {
  return event?.changeKind === 'runner-progress';
}

/**
 * @param {object} options
 * @param {{ subscribeChanges?: Function }} options.goalPlanStore
 * @param {(channel: string, payload: object) => void} options.broadcast
 * @param {() => ({ handleGoalPlanChanged?: Function }|null)} [options.getTaskNotificationBroker]
 * @param {number} [options.currentPid]
 * @param {(error: unknown) => void} [options.onError]
 * @param {number} [options.runnerProgressMinIntervalMs]
 * @param {{ setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout }} [options.timers]
 */
export function bindExternalGoalPlanChanges({
  goalPlanStore,
  broadcast,
  getTaskNotificationBroker = () => null,
  currentPid = process.pid,
  onError = reportGoalPlanChangeError,
  runnerProgressMinIntervalMs = 1000,
  timers = { setTimeout, clearTimeout },
}) {
  if (!goalPlanStore || typeof goalPlanStore.subscribeChanges !== 'function') return () => {};

  /** @type {Map<string, { payload: object, timer: ReturnType<typeof setTimeout>|null, lastSentAt: number, flushed?: boolean }>} */
  const softProgressByPlan = new Map();
  const minIntervalMs = Math.max(0, Number(runnerProgressMinIntervalMs) || 0);

  function emit(payload) {
    broadcast('goalPlans:changed', payload);
    try {
      getTaskNotificationBroker()?.handleGoalPlanChanged?.(payload);
    } catch (error) {
      onError(error);
    }
  }

  function softKey(event) {
    return String(event?.planId || event?.conversationId || '__unknown__');
  }

  function flushSoft(key) {
    const entry = softProgressByPlan.get(key);
    if (!entry || entry.flushed) return;
    if (entry.timer) {
      timers.clearTimeout(entry.timer);
      entry.timer = null;
    }
    const payload = entry.payload;
    entry.lastSentAt = Date.now();
    entry.flushed = true;
    emit(payload);
  }

  function scheduleSoft(event) {
    const key = softKey(event);
    const payload = {
      reason: event.reason ?? 'external-persist',
      planId: event.planId ?? null,
      conversationId: event.conversationId ?? null,
      changeKind: 'runner-progress',
      ...(event.runner ? { runner: event.runner } : {}),
    };
    const now = Date.now();
    let entry = softProgressByPlan.get(key);
    if (!entry) {
      entry = {
        payload,
        timer: null,
        lastSentAt: 0,
        flushed: false,
      };
      softProgressByPlan.set(key, entry);
    } else {
      entry.payload = payload;
      entry.flushed = false;
    }

    if (entry.timer) return;

    const wait = entry.lastSentAt
      ? Math.max(0, minIntervalMs - (now - entry.lastSentAt))
      : 0;
    if (wait === 0) {
      flushSoft(key);
      return;
    }
    entry.timer = timers.setTimeout(() => {
      entry.timer = null;
      flushSoft(key);
    }, wait);
  }

  function publishImmediate(event) {
    // Hard changes supersede pending soft progress for the same plan.
    const key = softKey(event);
    const pending = softProgressByPlan.get(key);
    if (pending?.timer) {
      timers.clearTimeout(pending.timer);
    }
    softProgressByPlan.delete(key);
    emit({
      reason: event.reason ?? 'external-persist',
      planId: event.planId ?? null,
      conversationId: event.conversationId ?? null,
      changeKind: event.changeKind ?? 'persist',
      ...(event.runner ? { runner: event.runner } : {}),
    });
  }

  const unsubscribe = goalPlanStore.subscribeChanges((event) => {
    if (!event || event.writerPid === currentPid) return;
    if (isSoftRunnerProgress(event)) {
      scheduleSoft(event);
      return;
    }
    publishImmediate(event);
  });

  return () => {
    for (const entry of softProgressByPlan.values()) {
      if (entry.timer) timers.clearTimeout(entry.timer);
    }
    softProgressByPlan.clear();
    unsubscribe();
  };
}
