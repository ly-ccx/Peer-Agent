import { DEFAULT_EXPLORER_CONCURRENCY, normalizeRunnerState } from "./goal-plan-domain.mjs";
import { normalizeGoalCheckpoint, validateGoalCheckpoint } from "@peer-agent/runtime-core";

/** Owns checkpoint compare-and-swap, commit ordering and interruption continuity through the existing store commit boundary. */
export function createGoalPlanCheckpoints({ getPlan, persist, appendRunEvent }) {



  function ensureRunnerRunId(plan, nowIso) {
    const current = normalizeRunnerState(plan.runner, plan.planId) || {
      enabled: false,
      status: 'idle',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: nowIso,
    };
    if (current.runId) return { plan, runner: current };
    const runId = `run-${nowIso.replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    const nextRunner = { ...current, runId, updatedAt: nowIso };
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    return { plan: nextPlan, runner: nextRunner };
  }

  /**
   * Prepare a Goal context checkpoint (write-ahead before destructive compaction).
   * CAS on plan.version / runId / previous checkpoint id.
   */
  function prepareContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const ensured = ensureRunnerRunId(plan, nowIso);
    const currentPlan = ensured.plan;
    const runner = ensured.runner;
    const expectedPlanVersion = Number.isFinite(input.expectedPlanVersion)
      ? Math.trunc(input.expectedPlanVersion)
      : currentPlan.version;
    if (currentPlan.version !== expectedPlanVersion) {
      const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on plan version`);
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    if (input.expectedRunId && runner.runId && input.expectedRunId !== runner.runId) {
      const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on runId`);
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const previous = runner.contextCheckpoint && typeof runner.contextCheckpoint === 'object'
      ? runner.contextCheckpoint
      : null;
    if (input.expectedPreviousCheckpointId) {
      const prevId = previous?.checkpointId || null;
      if (prevId !== input.expectedPreviousCheckpointId) {
        const err = new Error(`[goal-plan-store] prepareContextCheckpoint CAS conflict on previous checkpoint`);
        err.code = 'GOAL_CHECKPOINT_CONFLICT';
        throw err;
      }
    }

    const checkpoint = normalizeGoalCheckpoint({
      ...(input.checkpoint && typeof input.checkpoint === 'object' ? input.checkpoint : {}),
      status: 'preparing',
      planId: currentPlan.planId,
      planVersion: currentPlan.version,
      runId: runner.runId,
      conversationId: currentPlan.conversationId || input.conversationId || undefined,
      currentTaskId: input.currentTaskId || runner.currentTaskId || undefined,
      runnerPhase: input.runnerPhase || runner.phase || undefined,
      runnerIntent: input.runnerIntent || runner.intent || undefined,
      sequence: Number.isFinite(input.sequence)
        ? Math.trunc(input.sequence)
        : (Number.isFinite(previous?.sequence)
          ? Math.trunc(previous.sequence) + 1
          : (Number.isFinite(runner.lastConsumedCheckpointSequence)
            ? Math.trunc(runner.lastConsumedCheckpointSequence) + 1
            : 1)),
      reason: input.reason || input.checkpoint?.reason || 'soft_threshold',
      createdAt: nowIso,
    }, {
      fallbackPlanId: currentPlan.planId,
      fallbackRunId: runner.runId,
      fallbackPlanVersion: currentPlan.version,
      now: nowIso,
    });

    const nextRunner = normalizeRunnerState({
      ...runner,
      enabled: true,
      status: 'compacting_context',
      runId: runner.runId,
      contextCheckpoint: checkpoint,
      updatedAt: nowIso,
    }, currentPlan.planId);

    const nextPlan = persist({
      ...currentPlan,
      runner: nextRunner,
      updatedAt: nowIso,
    });

    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_prepared',
        summary: `Prepared context checkpoint ${checkpoint.checkpointId}`,
        payload: {
          checkpointId: checkpoint.checkpointId,
          sequence: checkpoint.sequence,
          digest: checkpoint.digest,
          reason: checkpoint.reason,
          currentTaskId: checkpoint.currentTaskId || null,
        },
      });
    } catch {
      // Event append failure must not roll back the prepared checkpoint.
    }

    return getPlan(planId) || nextPlan;
  }

  function commitContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId) || {
      enabled: true,
      status: 'compacting_context',
      turnCount: 0,
      roundCount: 0,
      toolCallCount: 0,
      explorerCount: 0,
      maxTurns: 8,
      maxToolCalls: 40,
      maxExplorers: 3,
      explorerConcurrency: DEFAULT_EXPLORER_CONCURRENCY,
      updatedAt: nowIso,
    };

    const expectedPlanVersion = Number.isFinite(input.expectedPlanVersion)
      ? Math.trunc(input.expectedPlanVersion)
      : plan.version;
    if (plan.version !== expectedPlanVersion) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on plan version');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    if (input.expectedRunId && runner.runId && input.expectedRunId !== runner.runId) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on runId');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }

    const preparing = runner.contextCheckpoint;
    const source = input.checkpoint && typeof input.checkpoint === 'object'
      ? input.checkpoint
      : preparing;
    if (!source) {
      const err = new Error('[goal-plan-store] commitContextCheckpoint requires a checkpoint');
      err.code = 'GOAL_CHECKPOINT_INVALID';
      throw err;
    }
    if (input.expectedPreviousCheckpointId) {
      // When committing an update, previous id is the preparing checkpoint id.
      const prevId = preparing?.checkpointId || null;
      if (prevId && prevId !== input.expectedPreviousCheckpointId && source.checkpointId !== input.expectedPreviousCheckpointId) {
        const err = new Error('[goal-plan-store] commitContextCheckpoint CAS conflict on previous checkpoint');
        err.code = 'GOAL_CHECKPOINT_CONFLICT';
        throw err;
      }
    }

    const checkpoint = normalizeGoalCheckpoint({
      ...source,
      status: 'committed',
      committedAt: nowIso,
      planId: plan.planId,
      planVersion: plan.version,
      runId: runner.runId || source.runId,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      fallbackPlanVersion: plan.version,
      now: nowIso,
    });
    const validated = validateGoalCheckpoint(checkpoint);
    if (!validated.ok) {
      const err = new Error(`[goal-plan-store] invalid checkpoint: ${validated.errors.join('; ')}`);
      err.code = 'GOAL_CHECKPOINT_INVALID';
      throw err;
    }

    const nextRunner = normalizeRunnerState({
      ...runner,
      enabled: true,
      status: 'compacting_context',
      runId: checkpoint.runId,
      contextCheckpoint: validated.checkpoint,
      updatedAt: nowIso,
    }, plan.planId);

    const nextPlan = persist({
      ...plan,
      runner: nextRunner,
      updatedAt: nowIso,
    });

    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_committed',
        summary: `Committed context checkpoint ${checkpoint.checkpointId}`,
        payload: {
          checkpointId: checkpoint.checkpointId,
          sequence: checkpoint.sequence,
          digest: checkpoint.digest,
          reason: checkpoint.reason,
          currentTaskId: checkpoint.currentTaskId || null,
        },
      });
    } catch {
      // non-fatal
    }

    return getPlan(planId) || nextPlan;
  }

  function markContextCompactionPersisted(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] markContextCompactionPersisted checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const nextCheckpoint = normalizeGoalCheckpoint({
      ...cp,
      status: 'committed',
      conversationRevision: input.conversationRevision || cp.conversationRevision,
      committedAt: cp.committedAt || nowIso,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || 'resuming_after_compaction',
      compactionCount: (Number.isFinite(runner.compactionCount) ? runner.compactionCount : 0) + 1,
      lastCompactionAt: nowIso,
      contextCheckpoint: nextCheckpoint,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_compaction_persisted',
        summary: `Persisted compaction for checkpoint ${nextCheckpoint.checkpointId}`,
        payload: {
          checkpointId: nextCheckpoint.checkpointId,
          sequence: nextCheckpoint.sequence,
          conversationRevision: nextCheckpoint.conversationRevision || null,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }

  function markContextCheckpointConsumed(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] markContextCheckpointConsumed checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const consumed = normalizeGoalCheckpoint({
      ...cp,
      status: 'consumed',
      consumedAt: nowIso,
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || 'running',
      contextCheckpoint: undefined,
      lastConsumedCheckpointId: consumed.checkpointId,
      lastConsumedCheckpointSequence: consumed.sequence,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_consumed',
        summary: `Consumed context checkpoint ${consumed.checkpointId}`,
        payload: {
          checkpointId: consumed.checkpointId,
          sequence: consumed.sequence,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }

  function supersedeContextCheckpoint(planId, input = {}) {
    const plan = getPlan(planId);
    if (!plan) return null;
    const nowIso = new Date().toISOString();
    const runner = normalizeRunnerState(plan.runner, planId);
    if (!runner?.contextCheckpoint) return plan;
    const cp = runner.contextCheckpoint;
    if (input.checkpointId && cp.checkpointId !== input.checkpointId) {
      const err = new Error('[goal-plan-store] supersedeContextCheckpoint checkpoint mismatch');
      err.code = 'GOAL_CHECKPOINT_CONFLICT';
      throw err;
    }
    const superseded = normalizeGoalCheckpoint({
      ...cp,
      status: 'superseded',
    }, {
      fallbackPlanId: plan.planId,
      fallbackRunId: runner.runId || plan.planId,
      now: nowIso,
    });
    const nextRunner = normalizeRunnerState({
      ...runner,
      status: input.runnerStatus || (runner.status === 'compacting_context' || runner.status === 'resuming_after_compaction' ? 'running' : runner.status),
      contextCheckpoint: undefined,
      updatedAt: nowIso,
    }, plan.planId);
    const nextPlan = persist({ ...plan, runner: nextRunner, updatedAt: nowIso });
    try {
      appendRunEvent(planId, {
        type: 'goal_checkpoint_superseded',
        summary: `Superseded context checkpoint ${superseded.checkpointId}`,
        payload: {
          checkpointId: superseded.checkpointId,
          sequence: superseded.sequence,
          reason: input.reason || null,
        },
      });
    } catch {
      // non-fatal
    }
    return getPlan(planId) || nextPlan;
  }
  return { supersedeContextCheckpoint, markContextCheckpointConsumed, markContextCompactionPersisted, commitContextCheckpoint, prepareContextCheckpoint };
}
