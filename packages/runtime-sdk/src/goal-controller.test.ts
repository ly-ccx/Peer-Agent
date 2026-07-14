import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeGoalController } from './goal-controller.ts';
import type { RuntimeGoalTaskExecutionResult } from './goal-contracts.ts';

function goalInput() {
  return {
    goalId: 'goal-1',
    sourcePlanId: 'plan-1',
    sessionId: 'session-1',
    title: 'Ship safely',
    goal: 'Deliver through the governed runtime.',
    tasks: [
      { taskId: 'inspect', title: 'Inspect the seam' },
      { taskId: 'implement', title: 'Implement the change' },
    ],
    successCriteria: [{ description: 'Tests pass' }],
  } as const;
}

test('runs tasks sequentially and requires evidence for completion', async () => {
  const calls: string[] = [];
  const controller = createRuntimeGoalController({
    executeTask: async (task) => {
      calls.push(task.taskId);
      return { status: 'completed', evidenceRefs: [`evidence://${task.taskId}`] };
    },
  });
  controller.create(goalInput());

  const snapshot = await controller.start('goal-1');
  assert.deepEqual(calls, ['inspect', 'implement']);
  assert.equal(snapshot.status, 'completed');
  assert.deepEqual(snapshot.tasks.map((task) => task.status), ['completed', 'completed']);
});

test('fails closed when a task claims completion without evidence', async () => {
  const controller = createRuntimeGoalController({
    executeTask: async () => ({ status: 'completed', evidenceRefs: [] }),
  });
  controller.create(goalInput());

  const snapshot = await controller.start('goal-1');
  assert.equal(snapshot.status, 'failed');
  assert.match(snapshot.reason ?? '', /Evidence/);
  assert.equal(snapshot.tasks[1]?.status, 'pending');
});

test('stops after failed and blocked task results', async (t) => {
  for (const result of [
    { status: 'failed', reason: 'provider failed' },
    { status: 'blocked', reason: 'approval required' },
  ] satisfies RuntimeGoalTaskExecutionResult[]) {
    await t.test(result.status, async () => {
      let calls = 0;
      const controller = createRuntimeGoalController({
        executeTask: async () => {
          calls += 1;
          return result;
        },
      });
      controller.create(goalInput());
      const snapshot = await controller.start('goal-1');
      assert.equal(snapshot.status, result.status);
      assert.equal(calls, 1);
      assert.equal(snapshot.tasks[1]?.status, 'pending');
    });
  }
});

test('pause waits for the running task and resume starts the next pending task', async () => {
  let release!: () => void;
  const firstTask = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const controller = createRuntimeGoalController({
    executeTask: async (task) => {
      calls.push(task.taskId);
      if (task.taskId === 'inspect') await firstTask;
      return { status: 'completed', evidenceRefs: [`evidence://${task.taskId}`] };
    },
  });
  controller.create(goalInput());
  const running = controller.start('goal-1');
  await Promise.resolve();
  controller.pause('goal-1');
  release();

  const paused = await running;
  assert.equal(paused.status, 'paused');
  assert.deepEqual(calls, ['inspect']);
  const completed = await controller.resume('goal-1');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(calls, ['inspect', 'implement']);
});

test('cancel aborts the active task and prevents later tasks', async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const calls: string[] = [];
  const controller = createRuntimeGoalController({
    executeTask: async (task, context) => {
      calls.push(task.taskId);
      entered();
      await new Promise<void>((resolve) => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'failed', reason: 'aborted' };
    },
  });
  controller.create(goalInput());
  const running = controller.start('goal-1');
  await started;
  controller.cancel('goal-1', 'user_cancelled');
  const snapshot = await running;

  assert.equal(snapshot.status, 'cancelled');
  assert.deepEqual(calls, ['inspect']);
  assert.ok(snapshot.tasks.every((task) => task.status === 'cancelled'));
});

test('one source plan can create only one goal', () => {
  const controller = createRuntimeGoalController({
    executeTask: async () => ({ status: 'completed', evidenceRefs: ['evidence://ok'] }),
  });
  controller.create(goalInput());
  assert.throws(() => controller.create({ ...goalInput(), goalId: 'goal-2' }), /already created goal/);
});
