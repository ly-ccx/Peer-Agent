import {
  createRuntimeGoalController,
  type RuntimeGoalController,
  type RuntimeGoalSnapshot,
  type RuntimeGoalTaskExecutionContext,
  type RuntimeGoalTaskExecutionResult,
  type RuntimeGoalTaskInput,
} from '@peer-agent/runtime-sdk';

import type { RuntimePlan } from './plan-mode.ts';

export interface TuiGoalRunner {
  create(plan: RuntimePlan): RuntimeGoalSnapshot;
  start(goalId: string): Promise<RuntimeGoalSnapshot>;
  pause(goalId: string): RuntimeGoalSnapshot;
  resume(goalId: string): Promise<RuntimeGoalSnapshot>;
  cancel(goalId: string): RuntimeGoalSnapshot;
  get(goalId: string): RuntimeGoalSnapshot | null;
  getByPlanId(planId: string): RuntimeGoalSnapshot | null;
  subscribe(listener: (snapshot: RuntimeGoalSnapshot) => void): () => void;
}

export function createTuiGoalRunner(options: {
  readonly sessionId: string;
  readonly executeTask: (
    task: RuntimeGoalTaskInput,
    context: RuntimeGoalTaskExecutionContext,
  ) => Promise<RuntimeGoalTaskExecutionResult>;
  readonly now?: () => string;
}): TuiGoalRunner {
  const goalIdsByPlan = new Map<string, string>();
  const controller: RuntimeGoalController = createRuntimeGoalController({
    executeTask: options.executeTask,
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    create(plan) {
      const existingId = goalIdsByPlan.get(plan.planId);
      if (existingId) {
        const existing = controller.get(existingId);
        if (existing) return existing;
      }

      const goalId = `${options.sessionId}:goal:${plan.planId}`;
      const snapshot = controller.create({
        goalId,
        sourcePlanId: plan.planId,
        sessionId: options.sessionId,
        title: plan.title,
        goal: plan.goal,
        tasks: plan.tasks,
        successCriteria: plan.successCriteria,
      });
      goalIdsByPlan.set(plan.planId, goalId);
      return snapshot;
    },
    start: (goalId) => controller.start(goalId),
    pause: (goalId) => controller.pause(goalId),
    resume: (goalId) => controller.resume(goalId),
    cancel: (goalId) => controller.cancel(goalId, 'cancelled_in_tui'),
    get: (goalId) => controller.get(goalId),
    getByPlanId(planId) {
      const goalId = goalIdsByPlan.get(planId);
      return goalId ? controller.get(goalId) : null;
    },
    subscribe: (listener) => controller.subscribe(listener),
  };
}
