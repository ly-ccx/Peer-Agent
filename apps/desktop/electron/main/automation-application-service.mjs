import { randomUUID } from 'node:crypto';

const ACTIVE_RUN_STATUSES = new Set([
  'scheduled', 'queued', 'preparing', 'running', 'waiting_permission', 'waiting_user',
]);

function requireId(payload, key) {
  const value = payload?.[key];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${key} is required`);
  return value.trim();
}

function snapshot(definition) {
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

export function createAutomationApplicationService({
  store,
  getRunner,
  getScheduler,
  now = () => new Date().toISOString(),
  logger = console,
} = {}) {
  if (!store) throw new TypeError('store is required');

  function summaries(input = {}) {
    return store.listDefinitions(input).map((definition) => {
      const runs = store.listRuns({ automationId: definition.automationId });
      const latestRun = runs[0];
      const activeRun = runs.find((run) => ACTIVE_RUN_STATUSES.has(run.status));
      return {
        definition,
        ...(latestRun ? { latestRun } : {}),
        ...(activeRun ? { activeRun } : {}),
        needsAttention: Boolean(latestRun && ['waiting_permission', 'waiting_user', 'failed', 'blocked', 'timed_out'].includes(latestRun.status)),
      };
    });
  }

  async function createManualRun(definition, { sourceRunId } = {}) {
    if (!definition) throw new Error('automation_not_found');
    const createdAt = now();
    const runId = randomUUID();
    const run = store.createRun({
      automationId: definition.automationId,
      idempotencyKey: `${definition.automationId}:manual:${runId}`,
      triggerSource: sourceRunId ? 'retry' : 'manual',
      ...(sourceRunId ? { sourceRunId } : {}),
      status: 'scheduled',
      scheduledAt: createdAt,
      snapshot: snapshot(definition),
    }, { runId, now: createdAt });
    const runner = getRunner?.();
    if (!runner?.run) {
      const failureReason = 'automation_runner_unavailable';
      logger?.error?.('[automation-application] run failed to start:', failureReason);
      return store.updateRun(run.runId, {
        status: 'failed',
        finishedAt: now(),
        failureReason,
        receipt: {
          error: 'Automation runner is unavailable.',
          evidence: [], evidenceRefs: [], verifications: [],
          completedAt: now(),
        },
      });
    }
    void runner.run(run).catch((error) => {
      const failureReason = error instanceof Error ? error.message : String(error || 'automation_runner_failed');
      logger?.error?.('[automation-application] runner failed:', error);
      const current = store.getRun(run.runId);
      if (current && ACTIVE_RUN_STATUSES.has(current.status)) {
        const finishedAt = now();
        store.updateRun(run.runId, {
          status: 'failed',
          finishedAt,
          failureReason,
          receipt: {
            error: failureReason,
            evidence: [], evidenceRefs: [], verifications: [],
            completedAt: finishedAt,
          },
        });
      }
    });
    return run;
  }

  return Object.freeze({
    bootstrap: () => ({ automations: summaries(), runtime: store.getRuntimeState() }),
    list: summaries,
    get: (payload) => store.getDefinition(requireId(payload, 'automationId')),
    create: (input) => store.createDefinition({ ...input, status: input.enable ? 'active' : 'draft' }),
    update: (input) => store.updateDefinition(requireId(input, 'automationId'), input.expectedVersion, input.patch),
    listRuns: (input) => store.listRuns(input),
    getRun: (payload) => store.getRun(requireId(payload, 'runId')),
    runNow: (payload) => createManualRun(store.getDefinition(requireId(payload, 'automationId'))),
    retryRun: (payload) => {
      const source = store.getRun(requireId(payload, 'runId'));
      if (!source) throw new Error('automation_run_not_found');
      return createManualRun(store.getDefinition(source.automationId), { sourceRunId: source.runId });
    },
    cancelRun: (payload) => {
      const runId = requireId(payload, 'runId');
      const run = store.getRun(runId);
      if (!run) throw new Error('automation_run_not_found');
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
      const finishedAt = now();
      return store.updateRun(runId, { status: 'cancelled', finishedAt, failureReason: 'cancelled_by_user' });
    },
    setRuntimePaused: (payload) => {
      if (typeof payload?.paused !== 'boolean') throw new TypeError('paused is required');
      const scheduler = getScheduler?.();
      return scheduler ? scheduler.setGloballyPaused(payload.paused) : store.setRuntimeState({ globallyPaused: payload.paused });
    },
  });
}
