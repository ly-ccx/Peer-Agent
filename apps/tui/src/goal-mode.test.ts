import { describe, expect, test } from 'bun:test';

import type { RuntimePlan } from './plan-mode.ts';
import { createTuiGoalRunner } from './goal-mode.ts';

const plan: RuntimePlan = {
  planId: 'plan-1',
  title: 'Ship safely',
  goal: 'Deliver through the governed runtime.',
  tasks: [
    { taskId: 'inspect', title: 'Inspect the seam' },
    { taskId: 'implement', title: 'Implement the change' },
  ],
  successCriteria: [{ description: 'Tests pass' }],
};

describe('TuiGoalRunner', () => {
  test('creates one goal per approved plan and executes tasks in order', async () => {
    const executed: string[] = [];
    const runner = createTuiGoalRunner({
      sessionId: 'session-a',
      executeTask: async (task) => {
        executed.push(task.taskId);
        return { status: 'completed', evidenceRefs: [`evidence://${task.taskId}`] };
      },
    });

    const first = runner.create(plan);
    const duplicate = runner.create(plan);
    expect(duplicate.goalId).toBe(first.goalId);

    const completed = await runner.start(first.goalId);
    expect(executed).toEqual(['inspect', 'implement']);
    expect(completed.status).toBe('completed');
    expect(completed.tasks.every((task) => task.evidenceRefs.length === 1)).toBe(true);
  });

  test('keeps plan identity isolated by session', () => {
    const first = createTuiGoalRunner({
      sessionId: 'session-a',
      executeTask: async () => ({ status: 'completed', evidenceRefs: ['evidence://a'] }),
    });
    const second = createTuiGoalRunner({
      sessionId: 'session-b',
      executeTask: async () => ({ status: 'completed', evidenceRefs: ['evidence://b'] }),
    });

    expect(first.create(plan).goalId).toBe('session-a:goal:plan-1');
    expect(second.create(plan).goalId).toBe('session-b:goal:plan-1');
  });
});
