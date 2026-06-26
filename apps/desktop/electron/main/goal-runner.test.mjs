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

/**
 * 创建一个已获批准的 plan。Runner 的批准准入闸门要求 plan.approval.decision === 'approve'
 * 才允许启动，绝大多数 start/pump 行为测试都需要先越过这道闸门。
 */
function createApprovedPlan(overrides = {}) {
  const plan = store.createPlan(draftWithTasks(overrides));
  store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'tester' });
  return store.getPlan(plan.planId);
}

test('approval gate: 未批准的 plan 调 start 会被拦下且不推进', async () => {
  const plan = store.createPlan(draftWithTasks());
  // 不调用 recordApproval —— plan 停在 awaiting_approval。
  const events = [];
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return {};
    },
  };
  const runner = createRunner({ runtime, events });

  const result = await runner.start(plan.planId, { awaitIdle: true });

  assert.equal(result, null);
  assert.equal(calls, 0, 'runGoalTurn 不应被调用');

  const got = store.getPlan(plan.planId);
  assert.notEqual(got.status, 'executing');
  assert.equal(got.runner.enabled, false);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'Goal Runner start blocked: plan is not approved');
  assert.ok(
    events.some((event) => event.type === 'goalRunner:blocked'),
    '应发出 goalRunner:blocked 事件',
  );
  assert.ok(
    !events.some((event) => event.type === 'goalRunner:started'),
    '不应发出 goalRunner:started 事件',
  );
});

test('approval gate: paused 状态的 plan 可被 start 放行（resume 场景）', async () => {
  const plan = createApprovedPlan();
  const runtime = {
    async runGoalTurn() {
      return { blocked: true, blockedReason: 'stop' };
    },
  };
  const runner = createRunner({ runtime });
  await runner.start(plan.planId, { awaitIdle: true });
  // 模拟外部把 plan 置为 paused（已越过批准、可重入）。
  store.setPlanStatus(plan.planId, 'paused');

  const result = await runner.start(plan.planId, { awaitIdle: true });
  assert.notEqual(result, null, 'paused 的 plan 应被放行');
});

test('start: 会把 plan/runner 置为 executing/running', async () => {
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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

test('no-progress: 连续 3 轮双信号无增长会 blocked(no_progress) 而非烧满预算', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const runtime = {
    // 每轮都不产生任何进展：不完成任务、不补 Evidence。
    async runGoalTurn() {
      calls += 1;
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 20, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  // 第 4 轮入口处 streak 达到 3，先于预算触发阻塞，故只跑了 3 轮。
  assert.equal(calls, 3);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'no_progress');
});

test('no-progress: 每轮补充叶子 Evidence 视为有进展，不会被误判阻塞', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const runtime = {
    // 每轮给叶子任务追加一条新的 Evidence：evidence 信号持续增长。
    async runGoalTurn({ planId }) {
      calls += 1;
      store.recordTaskEvidence(planId, 't1', { evidenceRefs: [`local-file://ev-${calls}`] });
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 5, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  // 持续有进展，不应被 no-progress 阻塞；预算用尽才停。
  assert.equal(calls, 5);
  assert.equal(got.runner.status, 'budget_exhausted');
});

test('fake runtime 连续返回 progress 时，Runner 能自动多 tick 推进并完成', async () => {
  const plan = createApprovedPlan();
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
  // 方案 B：tick 写回不再从 runGoalTurn 返回值累加 toolCallCount；展示用工具计数改由
  // main runGoalTurn 注入的实时 sink（onToolCall）拥有。此 fake runtime 未走该 sink，
  // 故 toolCallCount 保持初始 0。turnCount 仍按 tick 数累加。
  assert.equal(got.runner.toolCallCount, 0);
  assert.equal(got.runner.turnCount, 2);
});

test('Runner 每轮重新读 store，不依赖旧内存 plan', async () => {
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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
  const plan = createApprovedPlan();
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

test('explorer: runtime 返回 result.explorers 数组时全部派发并累加计数', async () => {
  const plan = createApprovedPlan();
  const events = [];
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      if (turnNumber === 1) {
        // 模拟 runGoalTurn 收集到模型本回合发起的两个 request_explorer 请求。
        return {
          intent: 'explore',
          explorers: [
            { planId: plan.planId, question: 'Q1：符号在哪被使用', reason: 'r1' },
            { planId: plan.planId, question: 'Q2：确认配置项默认值', reason: 'r2' },
          ],
        };
      }
      return { continue: false, intent: 'verify' };
    },
  };
  const explored = [];
  const explorerRunner = {
    async runExplorer({ explorer }) {
      explored.push(explorer.request.question);
      return {
        summary: 'done',
        findings: [{ claim: 'ok', evidenceRefs: ['local-file://x'] }],
        evidenceRefs: ['local-file://x'],
        confidence: 'medium',
        toolCallCount: 1,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.deepEqual(explored, ['Q1：符号在哪被使用', 'Q2：确认配置项默认值']);
  assert.equal(got.runner.explorerCount, 2);
  assert.equal(got.runner.explorers.length, 2);
  assert.ok(got.runner.explorers.every((e) => e.status === 'completed'));
});

test('explorer: 单回合请求数超过 maxExplorers 时被 store 上限兜底', async () => {
  const plan = createApprovedPlan();
  const events = [];
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      if (turnNumber === 1) {
        // 一次性请求 4 个，超过默认 maxExplorers=3。
        return {
          intent: 'explore',
          explorers: [1, 2, 3, 4].map((n) => ({
            planId: plan.planId,
            question: `Q${n}`,
            reason: `r${n}`,
          })),
        };
      }
      return { continue: false, intent: 'verify' };
    },
  };
  const explorerRunner = {
    async runExplorer() {
      return {
        summary: 'done',
        findings: [{ claim: 'ok', evidenceRefs: ['local-file://x'] }],
        evidenceRefs: ['local-file://x'],
        confidence: 'low',
        toolCallCount: 0,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  // store dispatchExplorer 在 explorers.length >= maxExplorers 时抛错，
  // Runner 不应突破上限：派发的 explorer 数受 maxExplorers 约束。
  assert.ok(got.runner.explorerCount <= got.runner.maxExplorers);
  assert.equal(got.runner.maxExplorers, 3);
});
