import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createDeterministicExplorePlan, createGoalRunner } from './goal-runner.mjs';

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

function createRunner({ runtime, explorerRunner = null, verifierRunner = null, events = [], logger = null } = {}) {
  return createGoalRunner({
    goalPlanStore: store,
    chatRuntime: runtime,
    explorerRunner,
    verifierRunner,
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

function registerEvidenceRefs(planId, refs) {
  const plan = store.getPlan(planId);
  return store.recordEvidenceRefs({
    planId,
    conversationId: plan?.conversationId,
    streamId: 'test-stream',
    toolCallId: `test-${String(planId).slice(0, 8)}`,
    toolName: 'test_evidence_source',
    evidenceRefs: refs,
    artifactRefs: refs,
  });
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

test('approval gate: accepted_goal 自驱契约可直接启动 Runner', async () => {
  const plan = store.createGoalContract(draftWithTasks({
    conversationId: 'conv-goal-runner',
    title: 'Self-driven Goal',
    goal: 'Run without plan approval',
  }));
  const events = [];
  const calls = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, turnNumber }) {
      calls.push({ status: currentPlan.status, workflowKind: currentPlan.workflowKind, turnNumber });
      return { continue: false, intent: 'verify' };
    },
  };
  const runner = createRunner({ runtime, events });

  const result = await runner.start(plan.planId, { awaitIdle: true });

  assert.notEqual(result, null);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    status: 'executing',
    workflowKind: 'goal_self_driven',
    turnNumber: 1,
  });

  const got = store.getPlan(plan.planId);
  assert.equal(got.approval, undefined);
  assert.equal(got.activation.kind, 'accepted_goal');
  assert.equal(got.runner.enabled, true);
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
  assert.ok(
    events.some((event) => event.type === 'goalRunner:started'),
    '应发出 goalRunner:started 事件',
  );
});

test('approval gate: paused 状态的 plan 可被 start 放行（resume 场景）', async () => {
  const plan = createApprovedPlan();
  const runtime = {
    async runGoalTurn() {
      return { continue: false, intent: 'verify' };
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
      return { continue: false, intent: 'verify' };
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
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
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
      return { continue: false, intent: 'verify' };
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

test('budget: 次数/轮次预算已移除，不再进入 budget_exhausted', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return {};
    },
  };
  const runner = createRunner({ runtime });

  // 即便 maxTurns 设得很小，Runner 也不再因 turnCount/toolCallCount 达到上限而停止。
  // 无进展时改由 no-progress 双信号护栏在连续 3 轮后阻塞，而非 budget_exhausted。
  await runner.start(plan.planId, { maxTurns: 2, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.notEqual(got.runner.status, 'budget_exhausted');
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'no_progress');
  // no-progress 在第 4 轮入口触发，故只跑了 3 轮，未受 maxTurns=2 约束。
  assert.equal(calls, 3);
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
      registerEvidenceRefs(planId, [`local-file://ev-${calls}`]);
      store.recordTaskEvidence(planId, 't1', { evidenceRefs: [`local-file://ev-${calls}`] });
      // 预算熔断已移除，持续有进展会无限推进；这里主动在第 5 轮请求停止收尾。
      if (calls >= 5) return { continue: false, intent: 'verify' };
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 5, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  // 持续有进展，不应被 no-progress 阻塞；也不再有 budget_exhausted。
  assert.equal(calls, 5);
  assert.notEqual(got.runner.status, 'budget_exhausted');
  assert.notEqual(got.runner.status, 'blocked');
  assert.equal(got.runner.status, 'idle');
});

test('fake runtime 连续返回 progress 时，Runner 能自动多 tick 推进并完成', async () => {
  const plan = createApprovedPlan();
  const seenTurnNumbers = [];
  const runtime = {
    async runGoalTurn({ planId, turnNumber }) {
      seenTurnNumbers.push(turnNumber);
      if (turnNumber === 1) {
        registerEvidenceRefs(planId, ['evidence://t1']);
        store.recordTaskEvidence(planId, 't1', {
          status: 'completed',
          evidenceRefs: ['evidence://t1'],
          result: 'done t1',
        });
      } else {
        registerEvidenceRefs(planId, ['evidence://t2']);
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
  assert.equal(got.runner.verifierRuns.length, 1);
  assert.equal(got.runner.verifierRuns[0].status, 'passed');
  assert.deepEqual(
    new Set(got.runner.verifierRuns[0].evidenceRefs),
    new Set(['evidence://t1', 'evidence://t2']),
  );
  // 方案 B：tick 写回不再从 runGoalTurn 返回值累加 toolCallCount；展示用工具计数改由
  // main runGoalTurn 注入的实时 sink（onToolCall）拥有。此 fake runtime 未走该 sink，
  // 故 toolCallCount 保持初始 0。turnCount 仍按 tick 数累加。
  assert.equal(got.runner.toolCallCount, 0);
  assert.equal(got.runner.turnCount, 2);
});

test('phase: Runner 按 orient -> inspect -> plan_scaffold -> act 推进', async () => {
  const plan = createApprovedPlan();
  const observed = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, planId, turnNumber }) {
      observed.push(currentPlan.runner?.phase);
      store.recordTaskEvidence(planId, 't1', { evidenceRefs: [`evidence://phase-${turnNumber}`] });
      if (turnNumber >= 4) return { continue: false, intent: 'verify' };
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });

  assert.deepEqual(observed, ['orient', 'inspect', 'plan_scaffold', 'act']);
  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.runner.phase, 'verify');
});

test('inspect planner: 复杂目标会生成 requiredBeforeAct ExplorePlan', () => {
  const plan = createApprovedPlan({
    targetWorkspacePath: '/repo/peer_agent',
    tasks: [
      { taskId: 't1', order: 0, title: 'Locate runtime entry', status: 'pending', evidenceRefs: [] },
      { taskId: 't2', order: 1, title: 'Implement change', status: 'pending', evidenceRefs: [] },
    ],
  });

  const inspectPlan = createDeterministicExplorePlan(plan, {
    generatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(inspectPlan.requiredBeforeAct, true);
  assert.equal(inspectPlan.generatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(inspectPlan.questions.length, 1);
  assert.match(inspectPlan.questions[0].question, /primary files, modules/);
  assert.deepEqual(inspectPlan.questions[0].scope.include, ['/repo/peer_agent']);
  assert.ok(inspectPlan.exitCriteria.length > 0);
});

test('inspect planner: requiredBeforeAct 先派 Explorer，完成后才进入 plan_scaffold', async () => {
  const plan = createApprovedPlan({
    targetWorkspacePath: '/repo/peer_agent',
    tasks: [
      { taskId: 't1', order: 0, title: 'Locate runtime entry', status: 'pending', evidenceRefs: [] },
      { taskId: 't2', order: 1, title: 'Implement change', status: 'pending', evidenceRefs: [] },
    ],
  });
  const turns = [];
  const explorerQuestions = [];
  const events = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, turnNumber }) {
      turns.push({ turnNumber, phase: currentPlan.runner?.phase });
      return turnNumber >= 2 ? { continue: false, intent: 'verify' } : {};
    },
  };
  const explorerRunner = {
    async runExplorer({ explorer }) {
      explorerQuestions.push(explorer.request.question);
      return {
        summary: 'runtime entry located',
        findings: [{ claim: 'entry found', evidenceRefs: ['tool-result://inspect-read'] }],
        evidenceRefs: ['tool-result://inspect-read'],
        allowedEvidenceRefs: ['tool-result://inspect-read'],
        confidence: 'high',
        toolCallCount: 1,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.deepEqual(turns, [
    { turnNumber: 1, phase: 'orient' },
    { turnNumber: 2, phase: 'plan_scaffold' },
  ]);
  assert.equal(explorerQuestions.length, 1);
  assert.match(explorerQuestions[0], /primary files, modules/);
  assert.equal(got.runner.inspectPlan.requiredBeforeAct, true);
  assert.equal(got.runner.explorerCount, 1);
  assert.equal(got.runner.explorers[0].request.question, explorerQuestions[0]);
  assert.equal(got.runner.explorers[0].batchId, `${plan.planId}:inspect:2`);
  assert.ok(events.some((event) => event.type === 'goalRunner:inspectPlan' && event.requiredBeforeAct));
});

test('Runner 每轮重新读 store，不依赖旧内存 plan', async () => {
  const plan = createApprovedPlan();
  const observedStatuses = [];
  const runtime = {
    async runGoalTurn({ plan: currentPlan, planId, turnNumber }) {
      observedStatuses.push(currentPlan.tasks[0].status);
      if (turnNumber === 1) {
        registerEvidenceRefs(planId, ['evidence://t1']);
        store.recordTaskEvidence(planId, 't1', {
          status: 'completed',
          evidenceRefs: ['evidence://t1'],
          result: 'done t1',
        });
        return {};
      }
      return { continue: false, intent: 'verify' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  assert.deepEqual(observedStatuses, ['pending', 'completed']);
  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
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

test('AgentRunOutcome: requestedUserInput 会阻塞 Runner 且不继续自驱', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return { requestedUserInput: true, blockedReason: 'requested_user_input' };
    },
  };
  const events = [];
  const runner = createRunner({ runtime, events });

  await runner.start(plan.planId, { maxTurns: 5, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(calls, 1);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.blockedReason, 'requested_user_input');
  assert.ok(events.some((event) => event.type === 'goalRunner:blocked' && event.requestedUserInput));
});

test('blocker audit: 同一 blocker 连续 3 次才进入 blocked', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const events = [];
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      return { blocked: true, blockedReason: 'temporary_blocker' };
    },
  };
  const runner = createRunner({ runtime, events });

  await runner.start(plan.planId, { awaitIdle: true });
  const blocked = store.getPlan(plan.planId);
  assert.equal(calls, 3);
  assert.equal(blocked.runner.status, 'blocked');
  assert.equal(blocked.runner.blockerAudit.occurrences, 3);
  assert.equal(blocked.runner.blockerAudit.reason, 'temporary_blocker');
  assert.equal(events.filter((event) => event.type === 'goalRunner:blockerObserved').length, 2);
  assert.ok(events.some((event) => event.type === 'goalRunner:blocked' && event.occurrences === 3));
});

test('blocker audit: resume 会清理旧 blocker fingerprint', async () => {
  const plan = createApprovedPlan();
  let calls = 0;
  const runtime = {
    async runGoalTurn() {
      calls += 1;
      if (calls <= 3) return { blocked: true, blockedReason: 'temporary_blocker' };
      return { continue: false, intent: 'verify' };
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });
  const blocked = store.getPlan(plan.planId);
  assert.equal(blocked.runner.status, 'blocked');
  assert.equal(blocked.runner.blockerAudit.occurrences, 3);

  await runner.resume(plan.planId, { awaitIdle: true });
  const resumed = store.getPlan(plan.planId);
  assert.equal(resumed.runner.status, 'idle');
  assert.equal(resumed.runner.blockerAudit, undefined);
  assert.equal(resumed.runner.blockedReason, undefined);
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
  assert.equal(got.runner.verifierRuns.length, 1);
  assert.equal(got.runner.verifierRuns[0].status, 'failed');
  assert.match(got.runner.verifierRuns[0].failureReason, /Verification gate failed/);
});

test('verifier: 完成门通过后会启动只读 Verifier，passed 后才 completed', async () => {
  const plan = createApprovedPlan();
  const verifierCalls = [];
  const runtime = {
    async runGoalTurn({ planId }) {
      registerEvidenceRefs(planId, ['evidence://t1', 'evidence://t2']);
      store.recordTaskEvidence(planId, 't1', {
        status: 'completed',
        evidenceRefs: ['evidence://t1'],
      });
      store.recordTaskEvidence(planId, 't2', {
        status: 'completed',
        evidenceRefs: ['evidence://t2'],
      });
      return {};
    },
  };
  const verifierRunner = {
    async runVerifier({ plan: currentPlan, verifierRunId }) {
      verifierCalls.push({ verifierRunId, status: currentPlan.status });
      return {
        passed: true,
        failedCriteria: [],
        missingEvidence: [],
        risks: [],
        evidenceRefs: ['evidence://t1', 'evidence://t2'],
        recommendedNextAction: 'synthesize',
      };
    },
  };
  const events = [];
  const runner = createRunner({ runtime, verifierRunner, events });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(verifierCalls.length, 1);
  assert.equal(got.status, 'completed');
  assert.equal(got.runner.status, 'completed');
  assert.equal(got.runner.verifierRuns.length, 1);
  assert.equal(got.runner.verifierRuns[0].status, 'passed');
  assert.equal(got.runner.verifierRuns[0].report.passed, true);
  assert.ok(events.some((event) => event.type === 'goalRunner:verifierStarted'));
  assert.ok(events.some((event) => event.type === 'goalRunner:verifierCompleted'));
});

test('manual DoD: self-driven Goal 完成前会阻塞等待人工确认', async () => {
  const plan = store.createGoalContract(draftWithTasks({
    successCriteria: [
      { id: 'manual-ux', kind: 'manual', description: '用户确认体验达标' },
    ],
  }));
  const runtime = {
    async runGoalTurn({ planId }) {
      registerEvidenceRefs(planId, ['evidence://t1', 'evidence://t2']);
      store.recordTaskEvidence(planId, 't1', {
        status: 'completed',
        evidenceRefs: ['evidence://t1'],
      });
      store.recordTaskEvidence(planId, 't2', {
        status: 'completed',
        evidenceRefs: ['evidence://t2'],
      });
      return {};
    },
  };
  const events = [];
  const runner = createRunner({ runtime, events });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.runner.blockedReason, 'manual_dod_confirmation_required');
  assert.deepEqual(got.manualConfirmations, []);
  assert.ok(events.some((event) => event.type === 'goalRunner:manualDodConfirmationRequired'));
  assert.ok(events.some((event) => event.type === 'goalRunner:blocked' && event.manualDodConfirmationRequired));
});

test('manual DoD: 记录确认后 self-driven Goal 才能完成', async () => {
  const plan = store.createGoalContract(draftWithTasks({
    successCriteria: [
      { id: 'manual-ux', kind: 'manual', description: '用户确认体验达标' },
    ],
  }));
  let calls = 0;
  const runtime = {
    async runGoalTurn({ planId }) {
      calls += 1;
      registerEvidenceRefs(planId, ['evidence://t1', 'evidence://t2']);
      store.recordTaskEvidence(planId, 't1', {
        status: 'completed',
        evidenceRefs: ['evidence://t1'],
      });
      store.recordTaskEvidence(planId, 't2', {
        status: 'completed',
        evidenceRefs: ['evidence://t2'],
      });
      return {};
    },
  };
  const runner = createRunner({ runtime });

  await runner.start(plan.planId, { awaitIdle: true });
  store.recordManualConfirmation(plan.planId, {
    confirmationId: 'manual-dod-1',
    kind: 'manual_dod',
    decision: 'approve',
    criterionIds: ['manual-ux'],
    decidedBy: 'tester',
  });
  await runner.resume(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(calls, 1, 'Manual DoD 确认后应直接进入验证/收束，不重复执行任务');
  assert.equal(got.status, 'completed');
  assert.equal(got.runner.status, 'completed');
  assert.equal(got.manualConfirmations[0].decision, 'approve');
  assert.equal(got.runner.verifierRuns[0].status, 'passed');
});

test('verifier: Verifier failed 时进入 repair/block，不完成计划', async () => {
  const plan = createApprovedPlan();
  const runtime = {
    async runGoalTurn({ planId }) {
      registerEvidenceRefs(planId, ['evidence://t1', 'evidence://t2']);
      store.recordTaskEvidence(planId, 't1', {
        status: 'completed',
        evidenceRefs: ['evidence://t1'],
      });
      store.recordTaskEvidence(planId, 't2', {
        status: 'completed',
        evidenceRefs: ['evidence://t2'],
      });
      return {};
    },
  };
  const verifierRunner = {
    async runVerifier() {
      return {
        passed: false,
        failedCriteria: [{ reason: 'claim not supported', evidenceRefs: [] }],
        missingEvidence: [],
        risks: ['needs repair'],
        evidenceRefs: ['evidence://t1'],
        recommendedNextAction: 'repair',
      };
    },
  };
  const events = [];
  const runner = createRunner({ runtime, verifierRunner, events });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.status, 'completed');
  assert.equal(got.runner.status, 'blocked');
  assert.equal(got.runner.phase, 'repair');
  assert.match(got.runner.blockedReason, /Verifier failed/);
  assert.equal(got.runner.verifierRuns.length, 1);
  assert.equal(got.runner.verifierRuns[0].status, 'failed');
  assert.equal(got.runner.verifierRuns[0].report.passed, false);
  assert.ok(events.some((event) => event.type === 'goalRunner:verifierFailed'));
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
    async runGoalTurn({ plan: currentPlan, turnNumber }) {
      turns.push({ turnNumber, phase: currentPlan.runner?.phase });
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
        findings: [{ claim: 'runner 字段存在', evidenceRefs: ['tool-result://goal-plan-store'] }],
        evidenceRefs: ['tool-result://goal-plan-store'],
        allowedEvidenceRefs: ['tool-result://goal-plan-store'],
        confidence: 'high',
        toolCallCount: 2,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.deepEqual(turns, [
    { turnNumber: 1, phase: 'orient' },
    { turnNumber: 2, phase: 'plan_scaffold' },
  ]);
  assert.equal(explorerCalls.length, 1);
  assert.equal(explorerCalls[0].request.question, '确认 GoalPlan store runner 字段');
  assert.equal(got.runner.status, 'idle');
  assert.equal(got.runner.intent, 'verify');
  assert.equal(got.runner.phase, 'verify');
  assert.equal(got.runner.explorerCount, 1);
  assert.equal(got.runner.toolCallCount, 2);
  assert.equal(got.runner.explorers[0].status, 'completed');
  assert.deepEqual(got.runner.explorers[0].evidenceRefs, ['tool-result://goal-plan-store']);
  assert.deepEqual(got.runner.explorers[0].report.evidenceRefs, ['tool-result://goal-plan-store']);
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
        findings: [{ claim: 'ok', evidenceRefs: ['tool-result://x'] }],
        evidenceRefs: ['tool-result://x'],
        allowedEvidenceRefs: ['tool-result://x'],
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

test('explorer: 单回合请求数超过并发上限时全部执行（并发池分批消化）', async () => {
  const plan = createApprovedPlan();
  const events = [];
  let maxInFlight = 0;
  let inFlight = 0;
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      if (turnNumber === 1) {
        // 一次性请求 6 个，超过并发上限（此处配置 concurrency=2）。
        return {
          intent: 'explore',
          explorers: [1, 2, 3, 4, 5, 6].map((n) => ({
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
      // 观测同时在飞的并发度，验证并发池不超过设定上限。
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        summary: 'done',
        findings: [{ claim: 'ok', evidenceRefs: ['tool-result://x'] }],
        evidenceRefs: ['tool-result://x'],
        allowedEvidenceRefs: ['tool-result://x'],
        confidence: 'low',
        toolCallCount: 0,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, explorerConcurrency: 2, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  // 不再有累计上限：6 个请求全部被派发并执行完成。
  assert.equal(got.runner.explorerCount, 6);
  assert.equal(got.runner.explorers.length, 6);
  assert.ok(got.runner.explorers.every((e) => e.status === 'completed'));
  // 并发池大小被 explorerConcurrency=2 约束：同时在飞不超过 2。
  assert.ok(maxInFlight <= 2, `maxInFlight=${maxInFlight} 应 <= 2`);
  assert.equal(got.runner.explorerConcurrency, 2);
});

test('explorer: 单个失败时 fail-soft，不中止同批其余 explorer', async () => {
  const plan = createApprovedPlan();
  const events = [];
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      if (turnNumber === 1) {
        return {
          intent: 'explore',
          explorers: [1, 2, 3].map((n) => ({
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
    async runExplorer({ explorer }) {
      // 第二个 explorer 抛错，其余应正常完成。
      if (explorer.request?.question === 'Q2') {
        throw new Error('boom');
      }
      return {
        summary: 'done',
        findings: [{ claim: 'ok', evidenceRefs: ['tool-result://x'] }],
        evidenceRefs: ['tool-result://x'],
        allowedEvidenceRefs: ['tool-result://x'],
        confidence: 'low',
        toolCallCount: 0,
      };
    },
  };
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { maxTurns: 3, awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.explorers.length, 3);
  const byStatus = got.runner.explorers.reduce((acc, e) => {
    acc[e.status] = (acc[e.status] || 0) + 1;
    return acc;
  }, {});
  // fail-soft：1 个 failed、2 个 completed，不因单个失败中止整批。
  assert.equal(byStatus.failed, 1);
  assert.equal(byStatus.completed, 2);
  assert.ok(events.some((e) => e.type === 'goalRunner:explorerFailed'));
});

test('explorer: 无真实 evidenceRefs 的报告不能 completed，会 fail-soft 标失败', async () => {
  const plan = createApprovedPlan();
  const runtime = {
    async runGoalTurn({ turnNumber }) {
      if (turnNumber === 1) {
        return {
          intent: 'explore',
          explorers: [{ planId: plan.planId, question: 'Q-no-evidence', reason: 'r' }],
        };
      }
      return { continue: false, intent: 'verify' };
    },
  };
  const explorerRunner = {
    async runExplorer() {
      return {
        summary: 'looked but returned no evidence',
        findings: [],
        evidenceRefs: [],
        confidence: 'low',
      };
    },
  };
  const events = [];
  const runner = createRunner({ runtime, explorerRunner, events });

  await runner.start(plan.planId, { awaitIdle: true });

  const got = store.getPlan(plan.planId);
  assert.equal(got.runner.explorers.length, 1);
  assert.equal(got.runner.explorers[0].status, 'failed');
  assert.match(
    got.runner.explorers[0].failureReason,
    /cannot be 'completed' without evidenceRefs/,
  );
  assert.ok(events.some((event) => event.type === 'goalRunner:explorerFailed'));
});
