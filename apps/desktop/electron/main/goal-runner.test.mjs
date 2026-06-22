import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

let tmpRoot;
let store;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'goal-runner-'));
  process.env.PEER_AGENT_HOME = path.join(tmpRoot, '.peer-agent');
  store = createGoalPlanStore();
});

afterEach(() => {
  delete process.env.PEER_AGENT_HOME;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function draftWithTasks(overrides = {}) {
  return {
    conversationId: 'conv-runner',
    title: 'Goal Runner test',
    goal: 'Finish runner tests',
    successCriteria: ['All tasks completed with Evidence'],
    tasks: [
      { taskId: 't1', order: 0, title: 'Task 1', status: 'pending', evidenceRefs: [] },
      { taskId: 't2', order: 1, title: 'Task 2', status: 'pending', evidenceRefs: [] },
    ],
    ...overrides,
  };
}

function createRunner({ runtime, explorerRunner = null, events = [], logger = null } = {}) {
  return createGoalRunner({
    goalPlanStore: store,
    chatRuntime: runtime,
    explorerRunner,
    emitEvent: (event) => events.push(event),
    now: () => '2026-01-01T00:00:00.000Z',
    logger: logger ?? { warn() {} },
  });
}

test('start: 会把 plan/runner 置为 executing/running', async () => {
  const plan = store.createPlan(draftWithTasks());
  const calls = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, turnNumber }) {
      calls.push({ status: currentPlan.status, turnNumber });
      return { blocked: true, blockedReason: 'stop after first tick' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].status, 'executing');
  assert.equal(got.status, 'executing');
  assert.equal(got.runner.enabled, true);
  assert.equal(got.runner.turnCount, 1);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'stop after first tick');
});

test('pause: 会停止后续 tick', async () => {
  const plan = store.createPlan(draftWithTasks());
  let release;
  const firstTurn = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      await firstTurn;
      return {};
    },
  };
  const runner = createRunner({ runtime });

  const startPromise = runner.start(plan.planId, { maxTurns: 5 });
  await new Promise((resolve) => setImmediate(resolve));
  const paused = runner.pause(plan.planId, 'manual pause');
  assert.equal(paused.planStatus, 'paused');
  assert.equal(paused.runner.status, 'paused');

  release({});
  await startPromise;
  await runner.waitForIdle(plan.planId);

  const got = store.getPlan(plan.planId);
  assert.equal(calls, 1);
  assert.equal(got.status, 'paused');
  assert.equal(got.runner.status, 'paused');
  assert.equal(got.runner.blockedReason, 'manual pause');
});

test('clear: 会 cancel plan 并停止 Runner', async () => {
  const plan = store.createPlan(draftWithTasks());
  const runtime = {
    async runGoalTurn() {
      return { blocked: true, blockedReason: 'should not matter' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });
  const cleared = runner.clear(plan.planId, 'user clear');

  assert.equal(cleared.planStatus, 'cancelled');
  assert.equal(cleared.runner.enabled, false);
  assert.equal(cleared.runner.status, 'idle');
  assert.equal(cleared.runner.blockedReason, 'user clear');
});

test('budget: maxTurns 用尽会进入 budget_exhausted', async () => {
  const plan = store.createPlan(draftWithTasks());
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 2, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(calls, 2);
  assert.equal(got.runner.turnCount, 2);
  assert.equal(got.runner.status, 'budget_exhausted');
});

test('fake runtime 连续返回 progress 时，Runner 能自动多 tick 推进并完成', async () => {
  const plan = store.createPlan(draftWithTasks());
  const seenTurnNumbers = [];
  const runtime = {
    async runGoalTurn({ planId, turnNumber }) {
      seenTurnNumbers.push(turnNumber);
      if (turnNumber === 1) {
        store.recordTaskEvidence(planId, 't1', {
          status: 'completed',
          evidenceRefs: ['evidence://t1'],
          result: 'done t1',
        });
      } else {
        store.recordTaskEvidence(planId, 't2', {
          status: 'completed',
          evidenceRefs: ['evidence://t2'],
          result: 'done t2',
        });
      }
      return { toolCallCount: 1 };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 5, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.deepEqual(seenTurnNumbers, [1, 2]);
  assert.equal(got.status, 'completed');
  assert.equal(got.progress.completed, 2);
  assert.equal(got.runner.status, 'completed');
  assert.equal(got.runner.enabled, false);
  assert.equal(got.runner.toolCallCount, 2);
});

test('Runner 每轮重新读 store，不依赖旧内存 plan', async () => {
  const plan = store.createPlan(draftWithTasks());
  const observedStatuses = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, planId, turnNumber }) {
      observedStatuses.push(currentPlan.tasks[0].status);
      if (turnNumber === 1) {
        store.recordTaskEvidence(planId, 't1', {
          status: 'completed',
          evidenceRefs: ['evidence://t1'],
          result: 'done t1',
        });
        return {};
      }
      return { blocked: true, blockedReason: 'observed fresh plan' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  assert.deepEqual(observedStatuses, ['pending', 'completed']);
  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'observed fresh plan');
});

test('runtime failed: 失败会进入 failed 状态', async () => {
  const plan = store.createPlan(draftWithTasks());
  const runtime = {
    async runGoalTurn() {
      throw new Error('runtime exploded');
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.status, 'failed');
  assert.equal(got.runner.status, 'failed');
  assert.equal(got.runner.lastError, 'runtime exploded');
});

test('completed result without task Evidence 会 blocked 而不是假装完成', async () => {
  const plan = store.createPlan(draftWithTasks());
  const runtime = {
    async runGoalTurn() {
      return { completed: true };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.status, 'executing');
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.progress.completed, 0);
});

test('runtime can request a single-turn stop without exhausting budget', async () => {
  const plan = store.createPlan(draftWithTasks());
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return { continue: false, intent: 'verify' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(calls, 1);
  assert.equal(got.status, 'executing');
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.runner.turnCount, 1);
});

test('explorer: runtime 可动态请求只读子 Agent，Runner 回填报告后继续推进', async () => {
  const plan = store.createPlan(draftWithTasks());
  const events = [];
  const turns = [];
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      turns.push(turnNumber);
      if (turnNumber === 1) {
        return {
          explore: {
            question: '确认 GoalPlan store runner 字段',
            reason: '主 Runner 证据不足',
            scope: { include: ['apps/desktop/electron/main/goal-plan-store.mjs'] },
            budget: { maxToolCalls: 2, maxDurationMs: 30000 },
          },
        };
      }
      return { continue: false, intent: 'verify' };
    },
  };
  const explorerCalls = [];
  const explorerRunner = {
    async runExplorer({ explorer }) {
      explorerCalls.push(explorer);
      return {
        summary: '已确认字段存在',
        findings: [{ claim: 'runner 字段存在', evidenceRefs: ['local-file://goal-plan-store'] }],
        evidenceRefs: ['local-file://goal-plan-store'],
        confidence: 'high',
        toolCallCount: 2,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.deepEqual(turns, [1, 2]);
  assert.equal(explorerCalls.length, 1);
  assert.equal(explorerCalls[0].request.question, '确认 GoalPlan store runner 字段');
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.runner.explorerCount, 1);
  assert.equal(got.runner.toolCallCount, 2);
  assert.equal(got.runner.explorers[0].status, 'completed');
  assert.deepEqual(got.runner.explorers[0].report.evidenceRefs, ['local-file://goal-plan-store']);
  assert.ok(events.some((event) => event.type === 'goalRunner:explorerStarted'));
  assert.ok(events.some((event) => event.type === 'goalRunner:explorerCompleted'));
});
