import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTuiGoalBridge, GOAL_CAPABILITY_IDS, GOAL_TOOL_NAMES } from './goal-bridge.ts';
import { createTuiSharedGoalRunner } from './goal-runner-adapter.ts';

/**
 * TUI Goal Runner 接入测试：验证「goal_create_plan 写盘后自动启动共享 Runner」
 * 与 Desktop 行为对齐——这是此前 CLI goal 模式「永远停在 0/0 · accepted」的缺失环节。
 */

function createFakeChat(options: {
  runGoalTurn?: (content: string, turnNumber: number) => unknown | Promise<unknown>;
  runExplorer?: (input: any) => unknown | Promise<unknown>;
  runVerifier?: (input: any) => unknown | Promise<unknown>;
} = {}) {
  const listeners = new Set<(snapshot: { status: string }) => void>();
  let status = 'idle';
  let turnNumber = 0;
  const sentMessages: string[] = [];
  return {
    sentMessages,
    setStatus(next: string) {
      status = next;
      for (const listener of listeners) listener({ status });
    },
    getSnapshot: () => ({ status }),
    subscribe(listener: (snapshot: { status: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async runGoalTurn(content: string) {
      sentMessages.push(content);
      turnNumber += 1;
      if (options.runGoalTurn) return options.runGoalTurn(content, turnNumber);
      return { continued: true as const, explorers: [], toolCallCount: 0 };
    },
    async runExplorer(input: any) {
      if (options.runExplorer) return options.runExplorer(input);
      return { status: 'failed', summary: 'unused fake explorer', evidenceRefs: [] };
    },
    async runVerifier(input: any) {
      if (options.runVerifier) return options.runVerifier(input);
      return { passed: false, summary: 'unused fake verifier', evidenceRefs: [] };
    },
  };
}

function createAcceptedGoalArgs() {
  return {
    title: 'Auto start goal',
    goal: 'Verify CLI auto-starts the shared Goal Runner after goal_create_plan',
    tasks: [{ title: 'First task' }, { title: 'Second task' }],
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createTuiSharedGoalRunner', () => {
  test('静态复用 Desktop goal-runner 与 intake 收敛闸门（不复制编排逻辑）', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./goal-runner-adapter.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain("from '../../desktop/electron/main/goal-runner.mjs'");
    expect(source).toContain("from '../../desktop/electron/main/goal-intake-convergence.mjs'");
    expect(source).toContain('createGoalRunner({');
    expect(source).toContain('recoverContextCheckpoints');
    expect(source).toContain('shouldAutoStartAcceptedGoalRunnerFromChange');
  });

  test('goal_create_plan 写盘后自动 kick Runner，runGoalTurn 驱动 chat 续跑', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-runner-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      const runner = createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-auto-start',
      });

      const events: string[] = [];
      runner.subscribe((event) => events.push(event.type));

      const created = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-auto-start',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      expect(created.result.status).toBe('success');
      const planId = (created.result.output as { planId?: string }).planId!;

      // 等 auto-start 异步 kick（onChange → whenIdle → runner.start → runGoalTurn）。
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Runner 已通过 chat.send 驱动了第一个 tick（Desktop runGoalTurn 同语义）。
      expect(chat.sentMessages.length).toBeGreaterThanOrEqual(1);
      expect(chat.sentMessages[0]).toContain('Goal Runner tick 1');
      expect(chat.sentMessages[0]).toContain(planId);
      // 至少发出了一个领域事件（started）。
      expect(events.some((type) => type === 'goalRunner:started')).toBe(true);
      // store 里 runner 状态已初始化（不再是「0/0 · accepted 后无响应」）。
      const plan = bridge.getPlan(planId);
      expect(plan?.runner?.enabled).toBe(true);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('共享 store 的多个 TUI runtime 只由 GoalPlan 所属 conversation 自动推进', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-owner-'));
    try {
      const ownerBridge = createTuiGoalBridge({ storeDir });
      const observerBridge = createTuiGoalBridge({ storeDir });
      const ownerChat = createFakeChat();
      const observerChat = createFakeChat();
      createTuiSharedGoalRunner({
        bridge: ownerBridge,
        chat: ownerChat as any,
        getConversationId: () => 'conv-owner',
      });
      createTuiSharedGoalRunner({
        bridge: observerBridge,
        chat: observerChat as any,
        getConversationId: () => 'conv-observer',
      });

      const created = await ownerBridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-owner',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      const planId = (created.result.output as { planId?: string }).planId!;

      await waitFor(() => ownerChat.sentMessages.length > 0);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(ownerChat.sentMessages[0]).toContain(planId);
      expect(observerChat.sentMessages).toHaveLength(0);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('等待活跃 turn 期间切换 conversation 后不会延迟串入 Goal tick', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-delayed-owner-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      chat.setStatus('streaming');
      let runtimeConversationId = 'conv-delayed-owner';
      createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => runtimeConversationId,
      });

      await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-delayed-owner',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      runtimeConversationId = 'conv-new-window';
      chat.setStatus('idle');
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(chat.sentMessages).toHaveLength(0);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('错误 conversation 手动 start 也不会写 runner 状态或发送 tick', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-manual-owner-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      const runner = createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-wrong',
        autoStart: false,
      });
      const created = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-owner',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      const planId = (created.result.output as { planId?: string }).planId!;
      const before = bridge.getPlan(planId)?.runner;

      await runner.start(planId);
      await runner.resume(planId);
      await runner.waitForIdle(planId);

      expect(chat.sentMessages).toHaveLength(0);
      expect(bridge.getPlan(planId)?.runner).toEqual(before);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('Runner 自己写盘触发的 change 不会反向自激重复 start', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-noloop-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-no-self-loop',
      });

      const created = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-no-self-loop',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      const planId = (created.result.output as { planId?: string }).planId!;
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterStart = chat.sentMessages.length;
      expect(afterStart).toBeGreaterThanOrEqual(1);

      // 再等一个窗口：若 onChange→start→appendRunEvent→onChange 自激，tick 数会无界增长。
      await new Promise((resolve) => setTimeout(resolve, 300));
      const later = chat.sentMessages.length;
      // 允许有限续跑，但不能爆炸式自激（同一 planId 的 start 幂等由 runner session 保证）。
      expect(later - afterStart).toBeLessThan(50);
      const plan = bridge.getPlan(planId);
      expect(plan?.runner?.enabled).toBe(true);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('Goal 回合登记的 Explorer 请求会由 TUI Worker 执行并回写真实 Evidence', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-explorer-'));
    let cleanupRunner: ReturnType<typeof createTuiSharedGoalRunner> | null = null;
    let cleanupPlanId: string | null = null;
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const exploredQuestions: string[] = [];
      const chat = createFakeChat({
        runGoalTurn: (_content, turnNumber) => turnNumber === 1
          ? {
              continued: true,
              explorers: [{
                question: 'Where is the target symbol used?',
                reason: 'Ground the next implementation step',
                scope: { include: ['apps/tui/src'], exclude: ['dist'] },
              }],
              toolCallCount: 1,
            }
          : { continue: false, intent: 'verify', toolCallCount: 0 },
        runExplorer: ({ explorer }) => {
          exploredQuestions.push(explorer.request.question);
          return {
            status: 'completed',
            summary: 'Found the governed usage',
            findings: [{
              claim: 'The symbol is used by the TUI Goal adapter.',
              evidenceRefs: ['tool-result://tui-explorer-evidence'],
            }],
            evidenceRefs: ['tool-result://tui-explorer-evidence'],
            toolEvidenceRefs: ['tool-result://tui-explorer-evidence'],
            confidence: 'high',
            toolCallCount: 1,
          };
        },
      });
      const runner = createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-explorer-worker',
        autoStart: false,
      });
      cleanupRunner = runner;

      const created = await bridge.execute({
        capabilityId: GOAL_CAPABILITY_IDS.create,
        conversationId: 'conv-explorer-worker',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      const planId = (created.result.output as { planId?: string }).planId!;
      cleanupPlanId = planId;

      await runner.start(planId);
      await waitFor(() => {
        const runnerState = bridge.getPlan(planId)?.runner;
        return runnerState?.explorers?.[0]?.status === 'completed'
          && (runnerState.toolCallCount ?? 0) >= 1;
      });

      expect(exploredQuestions).toEqual(['Where is the target symbol used?']);
      const plan = bridge.getPlan(planId);
      expect(plan?.runner?.explorers).toHaveLength(1);
      expect(plan?.runner?.explorers?.[0]).toMatchObject({
        status: 'completed',
        evidenceRefs: ['tool-result://tui-explorer-evidence'],
        report: {
          findings: [{
            claim: 'The symbol is used by the TUI Goal adapter.',
            evidenceRefs: ['tool-result://tui-explorer-evidence'],
          }],
          evidenceRefs: ['tool-result://tui-explorer-evidence'],
          confidence: 'high',
        },
      });
      expect(plan?.runner?.toolCallCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (cleanupRunner && cleanupPlanId) {
        const runner = cleanupRunner;
        const planId = cleanupPlanId;
        runner.clear(planId);
        await runner.waitForIdle(planId);
      }
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('完成门通过后会调用 TUI Verifier，并在报告通过后完成计划', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-verifier-'));
    let cleanupRunner: ReturnType<typeof createTuiSharedGoalRunner> | null = null;
    let cleanupPlanId: string | null = null;
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const verifierCalls: any[] = [];
      const taskEvidenceRefs = [
        'tool-result://tui-verifier-task-1',
        'tool-result://tui-verifier-task-2',
      ];
      const chat = createFakeChat({
        runGoalTurn: () => {
          const planId = cleanupPlanId!;
          bridge.store.recordEvidenceRefs({
            planId,
            conversationId: 'conv-verifier-worker',
            evidenceRefs: taskEvidenceRefs,
            toolCallId: 'tui-verifier-setup',
            capabilityId: 'local.file.read',
          });
          bridge.store.recordTaskEvidence(planId, 'verify-t1', {
            status: 'completed',
            evidenceRefs: [taskEvidenceRefs[0]],
          });
          bridge.store.recordTaskEvidence(planId, 'verify-t2', {
            status: 'completed',
            evidenceRefs: [taskEvidenceRefs[1]],
          });
          return {};
        },
        runVerifier: (input) => {
          verifierCalls.push(input);
          return {
            passed: true,
            summary: 'TUI verifier confirmed the governed evidence',
            failedCriteria: [],
            missingEvidence: [],
            risks: [],
            evidenceRefs: taskEvidenceRefs,
            recommendedNextAction: 'synthesize',
            toolCallCount: 1,
          };
        },
      });
      const runner = createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-verifier-worker',
        autoStart: false,
      });
      cleanupRunner = runner;

      const created = await bridge.execute({
        capabilityId: GOAL_CAPABILITY_IDS.create,
        conversationId: 'conv-verifier-worker',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: {
          title: 'Verify completed goal',
          goal: 'Complete only after the TUI Verifier checks governed evidence',
          tasks: [
            { taskId: 'verify-t1', title: 'First verified task' },
            { taskId: 'verify-t2', title: 'Second verified task' },
          ],
        },
      });
      const planId = (created.result.output as { planId?: string }).planId!;
      cleanupPlanId = planId;

      await runner.start(planId);
      await runner.waitForIdle(planId);

      expect(verifierCalls).toHaveLength(1);
      expect(verifierCalls[0]).toMatchObject({
        planId,
        gate: { passed: true },
      });
      expect(typeof verifierCalls[0].verifierRunId).toBe('string');
      const plan = bridge.getPlan(planId);
      expect(plan).toMatchObject({
        status: 'completed',
        progress: { total: 2, completed: 2, percent: 100 },
        runner: { status: 'completed' },
      });
      expect(plan?.runner?.verifierRuns).toHaveLength(1);
      expect(plan?.runner?.verifierRuns?.[0]).toMatchObject({
        verifierRunId: verifierCalls[0].verifierRunId,
        status: 'passed',
        evidenceRefs: taskEvidenceRefs,
        report: {
          passed: true,
          failedCriteria: [],
          missingEvidence: [],
          risks: [],
          evidenceRefs: taskEvidenceRefs,
          recommendedNextAction: 'synthesize',
        },
      });
    } finally {
      if (cleanupRunner && cleanupPlanId) {
        cleanupRunner.clear(cleanupPlanId);
        await cleanupRunner.waitForIdle(cleanupPlanId);
      }
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('进度展示取全量 plan（getPlan 含 tasks/progress），不再是 index meta 的 0/0', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-progress-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      createTuiSharedGoalRunner({
        bridge,
        chat: chat as any,
        getConversationId: () => 'conv-progress',
        autoStart: false,
      });

      const created = await bridge.execute({
        capabilityId: GOAL_CAPABILITY_IDS.create,
        conversationId: 'conv-progress',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: createAcceptedGoalArgs(),
      });
      const planId = (created.result.output as { planId?: string }).planId!;

      // index meta（listPlansByConversation 的返回）不含 tasks/progress —— 这就是旧 0/0 的来源。
      const metas = bridge.listPlansByConversation('conv-progress');
      expect(metas.length).toBeGreaterThan(0);
      // 全量 getPlan 才是 UI 进度展示该用的（与 Desktop 的 listPlanDetailsByConversation 对齐）。
      const full = bridge.getPlan(planId);
      expect(Array.isArray(full?.tasks)).toBe(true);
      expect(full.tasks.length).toBe(2);
      expect(full?.progress?.total).toBe(2);
      expect(typeof full?.progress?.percent).toBe('number');
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
