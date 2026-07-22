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

function createFakeChat() {
  const listeners = new Set<(snapshot: { status: string }) => void>();
  let status = 'idle';
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
    async send(content: string) {
      sentMessages.push(content);
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

describe('createTuiSharedGoalRunner', () => {
  test('静态复用 Desktop goal-runner 与 intake 收敛闸门（不复制编排逻辑）', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./goal-runner-adapter.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain("from '../../desktop/electron/main/goal-runner.mjs'");
    expect(source).toContain("from '../../desktop/electron/main/goal-intake-convergence.mjs'");
    expect(source).toContain('createGoalRunner({');
    expect(source).toContain('shouldAutoStartAcceptedGoalRunnerFromChange');
  });

  test('goal_create_plan 写盘后自动 kick Runner，runGoalTurn 驱动 chat 续跑', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-runner-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      const runner = createTuiSharedGoalRunner({ bridge, chat: chat as any });

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

  test('Runner 自己写盘触发的 change 不会反向自激重复 start', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-noloop-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      createTuiSharedGoalRunner({ bridge, chat: chat as any });

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

  test('进度展示取全量 plan（getPlan 含 tasks/progress），不再是 index meta 的 0/0', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-progress-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const chat = createFakeChat();
      createTuiSharedGoalRunner({ bridge, chat: chat as any });

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
