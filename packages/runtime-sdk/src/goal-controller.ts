import type {
  RuntimeGoalController,
  RuntimeGoalControllerOptions,
  RuntimeGoalCreateOptions,
  RuntimeGoalSnapshot,
  RuntimeGoalStatus,
  RuntimeGoalTaskSnapshot,
} from './goal-contracts.ts';

type GoalRecord = {
  snapshot: RuntimeGoalSnapshot;
  controller?: AbortController;
  run?: Promise<RuntimeGoalSnapshot>;
  pauseRequested: boolean;
};

export function createRuntimeGoalController(
  options: RuntimeGoalControllerOptions,
): RuntimeGoalController {
  const now = options.now ?? (() => new Date().toISOString());
  const goals = new Map<string, GoalRecord>();
  const planGoals = new Map<string, string>();
  const listeners = new Set<(snapshot: RuntimeGoalSnapshot) => void>();

  const publish = (record: GoalRecord, snapshot: RuntimeGoalSnapshot): RuntimeGoalSnapshot => {
    record.snapshot = snapshot;
    options.onChange?.(snapshot);
    for (const listener of listeners) listener(snapshot);
    return snapshot;
  };

  const update = (
    record: GoalRecord,
    change: Partial<RuntimeGoalSnapshot>,
  ): RuntimeGoalSnapshot => publish(record, {
    ...record.snapshot,
    ...change,
    updatedAt: now(),
  });

  const requireGoal = (goalId: string): GoalRecord => {
    const record = goals.get(goalId);
    if (!record) throw new Error(`Runtime goal ${goalId} does not exist.`);
    return record;
  };

  const run = async (record: GoalRecord): Promise<RuntimeGoalSnapshot> => {
    if (record.run) return record.run;
    record.pauseRequested = false;
    const controller = new AbortController();
    record.controller = controller;
    update(record, { status: 'running', reason: undefined });

    const promise = (async () => {
      try {
        while (!controller.signal.aborted) {
          if (record.pauseRequested) return update(record, { status: 'paused' });
          const taskIndex = record.snapshot.tasks.findIndex((task) => task.status === 'pending');
          if (taskIndex < 0) return update(record, { status: 'completed' });

          const startedAt = now();
          const runningTask: RuntimeGoalTaskSnapshot = {
            ...record.snapshot.tasks[taskIndex]!,
            status: 'running',
            startedAt,
          };
          const runningTasks = [...record.snapshot.tasks];
          runningTasks[taskIndex] = runningTask;
          update(record, { tasks: runningTasks });

          const result = await options.executeTask(runningTask, {
            goalId: record.snapshot.goalId,
            sourcePlanId: record.snapshot.sourcePlanId,
            sessionId: record.snapshot.sessionId,
            taskIndex,
            signal: controller.signal,
          });

          if (controller.signal.aborted) {
            const cancelledTasks = record.snapshot.tasks.map((task, index) => index === taskIndex
              ? { ...task, status: 'cancelled' as const, completedAt: now(), reason: String(controller.signal.reason ?? 'cancelled') }
              : task);
            return update(record, {
              status: 'cancelled',
              tasks: cancelledTasks,
              reason: String(controller.signal.reason ?? 'cancelled'),
            });
          }

          if (result.status === 'completed' && result.evidenceRefs.length === 0) {
            const failedTasks = [...record.snapshot.tasks];
            failedTasks[taskIndex] = {
              ...runningTask,
              status: 'failed',
              completedAt: now(),
              reason: 'Task completion requires Evidence.',
              evidenceRefs: [],
            };
            return update(record, {
              status: 'failed',
              tasks: failedTasks,
              reason: 'Task completion requires Evidence.',
            });
          }

          const tasks = [...record.snapshot.tasks];
          tasks[taskIndex] = {
            ...runningTask,
            status: result.status,
            completedAt: now(),
            reason: result.status === 'completed' ? undefined : result.reason,
            evidenceRefs: [...(result.evidenceRefs ?? [])],
          };
          if (result.status === 'blocked') {
            return update(record, { status: 'blocked', tasks, reason: result.reason });
          }
          if (result.status === 'failed') {
            return update(record, { status: 'failed', tasks, reason: result.reason });
          }
          update(record, { tasks });
        }
        return record.snapshot;
      } catch (error) {
        if (controller.signal.aborted) return record.snapshot;
        const reason = error instanceof Error ? error.message : String(error);
        const tasks = record.snapshot.tasks.map((task) => task.status === 'running'
          ? { ...task, status: 'failed' as const, completedAt: now(), reason }
          : task);
        return update(record, { status: 'failed', tasks, reason });
      } finally {
        record.controller = undefined;
        record.run = undefined;
      }
    })();
    record.run = promise;
    return promise;
  };

  return {
    create(input: RuntimeGoalCreateOptions): RuntimeGoalSnapshot {
      if (goals.has(input.goalId)) throw new Error(`Runtime goal ${input.goalId} already exists.`);
      if (planGoals.has(input.sourcePlanId)) {
        throw new Error(`Runtime plan ${input.sourcePlanId} already created goal ${planGoals.get(input.sourcePlanId)}.`);
      }
      if (input.tasks.length === 0) throw new Error('Runtime goal requires at least one task.');
      const createdAt = now();
      const snapshot: RuntimeGoalSnapshot = {
        goalId: input.goalId,
        sourcePlanId: input.sourcePlanId,
        sessionId: input.sessionId,
        title: input.title,
        goal: input.goal,
        status: 'pending',
        tasks: input.tasks.map((task) => ({ ...task, status: 'pending', evidenceRefs: [] })),
        successCriteria: [...(input.successCriteria ?? [])],
        createdAt,
        updatedAt: createdAt,
      };
      const record: GoalRecord = { snapshot, pauseRequested: false };
      goals.set(input.goalId, record);
      planGoals.set(input.sourcePlanId, input.goalId);
      return publish(record, snapshot);
    },

    start(goalId: string): Promise<RuntimeGoalSnapshot> {
      const record = requireGoal(goalId);
      if (record.snapshot.status !== 'pending') {
        throw new Error(`Runtime goal ${goalId} cannot start from ${record.snapshot.status}.`);
      }
      return run(record);
    },

    pause(goalId: string): RuntimeGoalSnapshot {
      const record = requireGoal(goalId);
      if (record.snapshot.status !== 'running') return record.snapshot;
      record.pauseRequested = true;
      return record.snapshot;
    },

    resume(goalId: string): Promise<RuntimeGoalSnapshot> {
      const record = requireGoal(goalId);
      if (record.snapshot.status === 'blocked') {
        const tasks = record.snapshot.tasks.map((task) => task.status === 'blocked'
          ? { ...task, status: 'pending' as const, startedAt: undefined, completedAt: undefined, reason: undefined }
          : task);
        update(record, { status: 'paused', tasks, reason: undefined });
      }
      if (record.snapshot.status !== 'paused') {
        throw new Error(`Runtime goal ${goalId} cannot resume from ${record.snapshot.status}.`);
      }
      return run(record);
    },

    cancel(goalId: string, reason = 'cancelled'): RuntimeGoalSnapshot {
      const record = requireGoal(goalId);
      const terminal: readonly RuntimeGoalStatus[] = ['completed', 'failed', 'cancelled'];
      if (terminal.includes(record.snapshot.status)) return record.snapshot;
      record.controller?.abort(reason);
      const tasks = record.snapshot.tasks.map((task) =>
        task.status === 'pending' || task.status === 'running' || task.status === 'blocked'
          ? { ...task, status: 'cancelled' as const, completedAt: now(), reason }
          : task);
      return update(record, { status: 'cancelled', tasks, reason });
    },

    get(goalId: string): RuntimeGoalSnapshot | null {
      return goals.get(goalId)?.snapshot ?? null;
    },

    list(): readonly RuntimeGoalSnapshot[] {
      return [...goals.values()].map((record) => record.snapshot);
    },

    subscribe(listener: (snapshot: RuntimeGoalSnapshot) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
