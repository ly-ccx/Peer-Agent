import { randomUUID } from 'node:crypto';
import { automationRunIsTerminal } from './automation-store.mjs';
import {
  latestAutomationOccurrence,
  nextAutomationOccurrence,
  validateAutomationSchedule,
} from './automation-schedule.mjs';

const MAX_TIMER_DELAY_MS = 2_147_000_000;
const ACTIVE_STATUSES = new Set([
  'scheduled', 'queued', 'preparing', 'running', 'waiting_permission', 'waiting_user',
]);

export function automationIdempotencyKey(automationId, scheduledAt) {
  return `${automationId}:${scheduledAt}`;
}

function snapshotDefinition(definition) {
  return {
    definitionVersion: definition.version,
    name: definition.name,
    prompt: definition.prompt,
    workspacePath: definition.workspacePath,
    ...(definition.modelProviderId !== undefined ? { modelProviderId: definition.modelProviderId } : {}),
    schedule: structuredClone(definition.schedule),
    grant: structuredClone(definition.grant),
    budget: structuredClone(definition.budget),
  };
}

function latestRunFor(store, automationId) {
  return store.listRuns({ automationId, limit: 1 })[0] || null;
}

function activeRunFor(store, automationId) {
  return store.listRuns({ automationId }).find((run) => ACTIVE_STATUSES.has(run.status)) || null;
}

function terminalRunForOnce(store, automationId) {
  return store.listRuns({ automationId }).find((run) => automationRunIsTerminal(run.status)) || null;
}

function createScheduledRun(store, definition, scheduledAt, { now, missedRecovery = false, status = 'scheduled', skippedReason } = {}) {
  const idempotencyKey = automationIdempotencyKey(definition.automationId, scheduledAt);
  const existing = store.findRunByIdempotencyKey(idempotencyKey);
  if (existing) return { run: existing, created: false };
  const run = store.createRun({
    automationId: definition.automationId,
    idempotencyKey,
    triggerSource: 'scheduled',
    status,
    scheduledAt,
    ...(missedRecovery ? { missedRecovery: true } : {}),
    ...(skippedReason ? { skippedReason } : {}),
    snapshot: snapshotDefinition(definition),
  }, { runId: randomUUID(), now });
  return { run, created: true };
}

/**
 * Reconciles persisted schedule facts at a point in time. It never starts an agent itself;
 * created runnable Runs are delivered through onRunReady.
 */
export function reconcileAutomationSchedules({ store, now = new Date().toISOString(), onRunReady } = {}) {
  if (!store) throw new TypeError('store is required');
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('now must be an ISO timestamp');
  const runtime = store.getRuntimeState();
  const result = { createdRunIds: [], skippedRunIds: [], updatedAutomationIds: [], errors: [] };

  for (const definition of store.listDefinitions({ statuses: ['active'] })) {
    try {
      validateAutomationSchedule(definition.schedule);
      if (runtime.globallyPaused) continue;

      const active = activeRunFor(store, definition.automationId);
      const cursor = definition.lastScheduledAt || definition.createdAt;
      const due = latestAutomationOccurrence(definition.schedule, { after: cursor, at: now });

      if (!due) {
        const next = nextAutomationOccurrence(definition.schedule, now);
        if (definition.nextRunAt !== next) {
          store.updateDefinitionRuntimeFacts(definition.automationId, { nextRunAt: next || undefined }, { now });
          result.updatedAutomationIds.push(definition.automationId);
        }
        continue;
      }

      const missed = Date.parse(due) < Math.floor(Date.parse(now) / 60_000) * 60_000;
      let createdResult;
      if (missed && definition.missedRunPolicy === 'skip') {
        createdResult = createScheduledRun(store, definition, due, {
          now, status: 'skipped', skippedReason: 'missed_policy', missedRecovery: true,
        });
      } else if (active && definition.overlapPolicy === 'skip') {
        createdResult = createScheduledRun(store, definition, due, {
          now, status: 'skipped', skippedReason: 'overlap', missedRecovery: missed,
        });
      } else {
        createdResult = createScheduledRun(store, definition, due, { now, missedRecovery: missed });
      }

      const next = nextAutomationOccurrence(definition.schedule, due);
      const onceConsumed = definition.schedule.kind === 'once';
      store.updateDefinitionRuntimeFacts(definition.automationId, {
        lastScheduledAt: due,
        nextRunAt: next || undefined,
        ...(onceConsumed && createdResult.run.status === 'skipped' ? { status: 'completed' } : {}),
      }, { now });
      result.updatedAutomationIds.push(definition.automationId);

      if (createdResult.created && createdResult.run.status === 'scheduled') {
        result.createdRunIds.push(createdResult.run.runId);
        try { onRunReady?.(createdResult.run); } catch (error) {
          result.errors.push({ automationId: definition.automationId, error: error?.message || String(error) });
        }
      } else if (createdResult.created) {
        result.skippedRunIds.push(createdResult.run.runId);
      }
    } catch (error) {
      result.errors.push({ automationId: definition.automationId, error: error?.message || String(error) });
      try {
        store.updateDefinitionRuntimeFacts(definition.automationId, {
          status: 'disabled', pauseReason: 'configuration_invalid', nextRunAt: undefined,
        }, { now });
      } catch { /* preserve original reconciliation failure */ }
    }
  }
  return result;
}

export function completeOnceAutomationIfNeeded(store, run, { now = new Date().toISOString() } = {}) {
  if (!automationRunIsTerminal(run?.status)) return null;
  const definition = store.getDefinition(run.automationId);
  if (!definition || definition.schedule.kind !== 'once' || definition.status !== 'active') return definition;
  if (!terminalRunForOnce(store, definition.automationId)) return definition;
  return store.updateDefinitionRuntimeFacts(definition.automationId, {
    status: 'completed', nextRunAt: undefined, lastRunAt: run.finishedAt || now,
  }, { now });
}

export function createAutomationScheduler({
  store,
  onRunReady,
  clock = () => Date.now(),
  scheduleTimer = (callback, delay) => setTimeout(callback, delay),
  cancelTimer = (timer) => clearTimeout(timer),
  minimumWakeMs = 1_000,
} = {}) {
  if (!store) throw new TypeError('store is required');
  let timer = null;
  let stopped = true;
  let reconciling = false;

  function clearWake() {
    if (timer != null) cancelTimer(timer);
    timer = null;
  }

  function nextWakeDelay() {
    const nowMs = clock();
    const nextMs = store.listDefinitions({ statuses: ['active'] })
      .map((definition) => Date.parse(definition.nextRunAt || ''))
      .filter(Number.isFinite)
      .reduce((minimum, value) => Math.min(minimum, value), Infinity);
    if (!Number.isFinite(nextMs)) return null;
    return Math.max(minimumWakeMs, Math.min(MAX_TIMER_DELAY_MS, nextMs - nowMs));
  }

  function arm() {
    clearWake();
    if (stopped || store.getRuntimeState().globallyPaused) return;
    const delay = nextWakeDelay();
    if (delay == null) return;
    timer = scheduleTimer(() => { timer = null; reconcile('timer'); }, delay);
  }

  function reconcile(reason = 'manual') {
    if (reconciling) return { reason, skipped: 'already_reconciling' };
    reconciling = true;
    try {
      const now = new Date(clock()).toISOString();
      const result = reconcileAutomationSchedules({ store, now, onRunReady });
      arm();
      return { reason, ...result };
    } finally {
      reconciling = false;
    }
  }

  function start() {
    if (!stopped) return reconcile('restart');
    stopped = false;
    return reconcile('startup');
  }

  function stop() {
    stopped = true;
    clearWake();
  }

  function handleResume() {
    if (stopped) return null;
    return reconcile('resume');
  }

  function handleTimeChange() {
    if (stopped) return null;
    return reconcile('time_change');
  }

  function notifyDefinitionChanged() {
    if (stopped) return null;
    return reconcile('definition_changed');
  }

  function setGloballyPaused(paused) {
    const now = new Date(clock()).toISOString();
    const wasPaused = store.getRuntimeState().globallyPaused;
    if (!paused && wasPaused) {
      for (const definition of store.listDefinitions({ statuses: ['active'] })) {
        const nextRunAt = nextAutomationOccurrence(definition.schedule, now);
        store.updateDefinitionRuntimeFacts(definition.automationId, {
          lastScheduledAt: now,
          nextRunAt: nextRunAt || undefined,
        }, { now });
      }
    }
    const state = store.setRuntimeState({
      globallyPaused: Boolean(paused),
      ...(paused ? { pausedAt: now } : { pausedAt: undefined }),
    }, { now });
    if (paused) clearWake(); else reconcile('global_resume');
    return state;
  }

  return {
    start,
    stop,
    reconcile,
    handleResume,
    handleTimeChange,
    notifyDefinitionChanged,
    setGloballyPaused,
    get stopped() { return stopped; },
  };
}
