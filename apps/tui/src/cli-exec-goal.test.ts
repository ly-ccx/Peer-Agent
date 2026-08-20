import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTuiGoalBridge, GOAL_TOOL_NAMES } from './goal-bridge.ts';
import { CLI_EXIT } from './cli-exit.ts';
import { encodeExecJson, type ExecJsonResult } from './cli-output.ts';
import { collectPlanIds, driveNewGoalPlansToSettled } from './cli-exec-goal.ts';

/**
 * exec 自驱闭环测试：`peer exec "任务"` 里模型新建的 GoalPlan 由 exec 进程内的
 * 共享 Goal Runner 驱动到终态；停止语义映射退出码与 JSON 报告；无 goal 行为不变。
 *
 * 与 goal-runner-adapter.test.ts 的区别：那组测试验证 auto-start（TUI 场景），
 * 这组验证 exec 的显式驱动 + 退出码/JSON 映射（headless 场景）。
 */

function createFakeChat(options: {
  /** pump 经 TUI adapter 转换后调用：runGoalTurn(tickMessage 字符串)。按调用序号编排剧本。 */
  onTurn?: (callIndex: number) => unknown | Promise<unknown>;
  verifierPassed?: boolean;
} = {}) {
  const listeners = new Set<(snapshot: { status: string }) => void>();
  let status = 'idle';
  let callIndex = 0;
  const sentMessages: string[] = [];
  return {
    sentMessages,
    getSnapshot: () => ({ status }),
    subscribe(listener: (snapshot: { status: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async runGoalTurn(content: string) {
      sentMessages.push(content);
      callIndex += 1;
      if (options.onTurn) return options.onTurn(callIndex);
      return { continued: true as const, explorers: [], toolCallCount: 0 };
    },
    async runExplorer() {
      return { status: 'failed', summary: 'unused fake explorer', evidenceRefs: [] };
    },
    async runVerifier() {
      // 默认放行：exec 场景的独立 verifier 复核由专门测试覆盖。
      return {
        passed: options.verifierPassed ?? true,
        summary: 'fake verifier',
        evidenceRefs: ['tool-result://exec-goal-verifier'],
      };
    },
  };
}

async function createPlan(bridge: any, conversationId: string, args: Record<string, unknown>) {
  const created = await bridge.execute({
    capabilityId: GOAL_TOOL_NAMES.createPlan,
    conversationId,
    mode: 'goal',
    workspaceRoot: process.cwd(),
    args,
  });
  if (created.result.status !== 'success') {
    throw new Error(`createPlan failed: ${JSON.stringify(created.result)}`);
  }
  return (created.result.output as { planId: string }).planId;
}

/** 等待 store 里计划达到给定状态（Runner 泵异步写盘）。 */
async function waitForPlan(
  bridge: any,
  planId: string,
  predicate: (plan: any) => boolean,
  timeoutMs = 3_000,
): Promise<any> {
  const startedAt = Date.now();
  for (;;) {
    const plan = bridge.getPlan(planId);
    if (plan && predicate(plan)) return plan;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for plan state; last=${JSON.stringify(plan?.status)}/${JSON.stringify(plan?.runner?.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function baseGoalArgs(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Exec self-driven goal',
    goal: 'Verify peer exec drives a freshly created plan to terminal state',
    tasks: [{ title: 'First task' }],
    successCriteria: [
      { id: 'crit-file', kind: 'file-exists', detail: 'outcome marker file exists' },
    ],
    ...overrides,
  };
}

describe('driveNewGoalPlansToSettled', () => {
  test('无新计划时不驱动：行为与旧版 exec 完全一致', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-exec-goal-none-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const conversationId = 'conv-no-goal';
      // send() 前没有计划；send() 后也没有新计划（模型没建 goal）。
      const planIdsBefore = collectPlanIds(bridge, conversationId);
      const outcome = await driveNewGoalPlansToSettled({
        bridge,
        chat: createFakeChat() as any,
        getConversationId: () => conversationId,
        planIdsBefore,
      });
      expect(outcome.drove).toBe(false);
      expect(outcome.exitKind).toBe('ok');
      expect(outcome.report).toBeNull();
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('send() 前已存在的旧计划不被接管（exec 只驱动本轮新建）', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-exec-goal-old-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const conversationId = 'conv-existing-plan';
      await createPlan(bridge, conversationId, baseGoalArgs());
      const planIdsBefore = collectPlanIds(bridge, conversationId);
      // send() 后无新计划 → 不驱动。
      const chat = createFakeChat();
      const outcome = await driveNewGoalPlansToSettled({
        bridge,
        chat: chat as any,
        getConversationId: () => conversationId,
        planIdsBefore,
      });
      expect(outcome.drove).toBe(false);
      expect(chat.sentMessages.length).toBe(0);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('新计划被共享 Runner 驱动：模型完成子任务+DoD 通过 → completed → ok', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-exec-goal-ok-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const conversationId = 'conv-ok';
      const planIdsBefore = collectPlanIds(bridge, conversationId);

      // send() 轮：模型建计划。
      const planId = await createPlan(bridge, conversationId, baseGoalArgs());

      // Runner 轮：模型用 goal_update_task 完成带 evidence 的子任务，再声明完成。
      const chat = createFakeChat({
        async onTurn(turnNumber: number) {
          if (turnNumber === 1) {
            const taskId = bridge.getPlan(planId)?.tasks?.[0]?.taskId;
            // 模拟真实链路：工具执行成功后由 host 把 evidence 记入 store 索引
            // （tui-host.ts 的 recordEvidenceRefs 路径），否则 gate 报 unindexed。
            bridge.store.recordEvidenceRefs({
              conversationId,
              planId,
              streamId: null,
              toolCallId: 'exec-goal-test-call',
              capabilityId: 'local.bash',
              evidenceRefs: ['local-shell-artifact://exec-goal-test/stdout'],
            });
            await bridge.execute({
              capabilityId: 'goal_update_task',
              conversationId,
              mode: 'goal',
              workspaceRoot: process.cwd(),
              args: {
                planId,
                taskId,
                status: 'completed',
                evidenceRefs: ['local-shell-artifact://exec-goal-test/stdout'],
              },
            });
            // 机器可验标准：模型声明完成时回填 criterion 结果（带已索引 evidence）。
            bridge.store.recordCriterionResults(planId, [
              {
                criterionId: 'crit-file',
                passed: true,
                evidenceRef: 'local-shell-artifact://exec-goal-test/stdout',
              },
            ]);
            return { continued: true, explorers: [], toolCallCount: 1, completed: true };
          }
          return { continued: false, explorers: [], toolCallCount: 0 };
        },
      });

      const outcome = await driveNewGoalPlansToSettled({
        bridge,
        chat: chat as any,
        getConversationId: () => conversationId,
        planIdsBefore,
      });

      expect(outcome.drove).toBe(true);
      expect(chat.sentMessages.length).toBeGreaterThanOrEqual(1);
      const finalPlan = bridge.getPlan(planId);
      // DoD 全机器可验 + evidence 齐 → 计划应到 completed。
      expect(finalPlan?.status).toBe('completed');
      expect(outcome.exitKind).toBe('ok');
      expect(outcome.report?.planId).toBe(planId);
      expect(outcome.report?.planStatus).toBe('completed');
      expect(outcome.report?.progress?.completed).toBe(1);
      expect(outcome.report?.progress?.total).toBe(1);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('manual DoD：headless 无放行旗标 → blocked（不自完成）→ waitingUser 退出码', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-exec-goal-manual-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const conversationId = 'conv-manual-dod';
      const planIdsBefore = collectPlanIds(bridge, conversationId);

      const planId = await createPlan(bridge, conversationId, baseGoalArgs({
        successCriteria: [
          { id: 'crit-machine', kind: 'file-exists', detail: 'marker file exists' },
          { id: 'crit-human', kind: 'manual', detail: 'human accepts the result' },
        ],
      }));

      const chat = createFakeChat({
        async onTurn(turnNumber: number) {
          if (turnNumber === 1) {
            const taskId = bridge.getPlan(planId)?.tasks?.[0]?.taskId;
            // 机器标准补齐 evidence 索引 + criterion 结果；manual 标准故意留白
            // → gate 应转 manual_confirmation_required，headless 不放行。
            bridge.store.recordEvidenceRefs({
              conversationId,
              planId,
              streamId: null,
              toolCallId: 'exec-goal-test-call',
              capabilityId: 'local.bash',
              evidenceRefs: ['local-shell-artifact://exec-goal-test/stdout'],
            });
            await bridge.execute({
              capabilityId: 'goal_update_task',
              conversationId,
              mode: 'goal',
              workspaceRoot: process.cwd(),
              args: {
                planId,
                taskId,
                status: 'completed',
                evidenceRefs: ['local-shell-artifact://exec-goal-test/stdout'],
              },
            });
            bridge.store.recordCriterionResults(planId, [
              {
                criterionId: 'crit-machine',
                passed: true,
                evidenceRef: 'local-shell-artifact://exec-goal-test/stdout',
              },
            ]);
            return { continued: true, explorers: [], toolCallCount: 1, completed: true };
          }
          return { continued: false, explorers: [], toolCallCount: 0 };
        },
      });

      const outcome = await driveNewGoalPlansToSettled({
        bridge,
        chat: chat as any,
        getConversationId: () => conversationId,
        planIdsBefore,
      });

      expect(outcome.drove).toBe(true);
      // headless 不放行 manual DoD：Runner 必须 blocked，exec 必须 waiting_user 退出。
      // 注：Runner 语义是 plan 停留 completed + runner blocked（manual_dod_confirmation_required），
      // 人工闸门挂在 runner 状态上，不撤销机器侧结论——所以断言以 runner/退出码为准。
      const finalPlan = bridge.getPlan(planId);
      expect(finalPlan?.runner?.status).toBe('blocked');
      expect(finalPlan?.runner?.blockedReason).toBe('manual_dod_confirmation_required');
      expect(outcome.exitKind).toBe('waiting_user');
      expect(outcome.report?.pendingManualDoD).toContain('crit-human');
      // 退出码映射：waiting_user → CLI_EXIT.waitingUser（非零）。
      expect(CLI_EXIT.waitingUser).not.toBe(0);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('waiting_user：待答问题进入 JSON 报告 → waitingUser 退出码', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-exec-goal-wait-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const conversationId = 'conv-waiting';
      const planIdsBefore = collectPlanIds(bridge, conversationId);
      const planId = await createPlan(bridge, conversationId, baseGoalArgs());

      // Runner 轮：模型走 request_user_input 语义（runner 级 waiting_user 唯一真实路径）。
      const chat = createFakeChat({
        async onTurn() {
          return {
            continued: true,
            explorers: [],
            toolCallCount: 0,
            requestedUserInput: true,
            blockedReason: 'requested_user_input',
          };
        },
      });

      const outcome = await driveNewGoalPlansToSettled({
        bridge,
        chat: chat as any,
        getConversationId: () => conversationId,
        planIdsBefore,
      });

      expect(outcome.drove).toBe(true);
      expect(outcome.exitKind).toBe('waiting_user');
      expect(outcome.report?.runnerStatus).toBe('waiting_user');
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});

describe('exec JSON 输出契约', () => {
  test('goal 报告进入 encodeExecJson 且向后兼容（无 goal 字段时省略）', () => {
    const base: ExecJsonResult = {
      sessionId: 's1',
      ok: true,
      result: 'done',
      error: null,
      turns: 3,
      durationMs: 100,
    };
    expect(JSON.parse(encodeExecJson(base)).goal).toBeUndefined();

    const withGoal: ExecJsonResult = {
      ...base,
      goal: {
        planId: 'p1',
        planStatus: 'blocked',
        runnerStatus: 'blocked',
        exitReason: 'manual_dod_confirmation_required',
        blockedReason: 'manual DoD awaiting confirmation',
        waitingQuestion: null,
        pendingManualDoD: ['crit-human'],
        progress: { completed: 1, total: 2 },
      },
    };
    const parsed = JSON.parse(encodeExecJson(withGoal)) as { goal: Record<string, unknown> };
    expect(parsed.goal.planId).toBe('p1');
    expect(parsed.goal.pendingManualDoD).toEqual(['crit-human']);
    expect(parsed.goal.progress).toEqual({ completed: 1, total: 2 });
  });

  test('退出码语义：waitingUser/goalFailed 均为非零且互不相同', () => {
    expect(CLI_EXIT.waitingUser).toBe(6);
    expect(CLI_EXIT.goalFailed).toBe(7);
    expect(CLI_EXIT.ok).toBe(0);
  });
});
