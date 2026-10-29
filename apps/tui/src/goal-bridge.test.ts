import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTuiGoalBridge, GOAL_CAPABILITY_IDS, GOAL_TOOL_NAMES } from './goal-bridge.ts';

describe('TuiGoalBridge', () => {
  test('statically imports the shared Node GoalPlan store for packaged CLI', async () => {
    const source = await readFile(new URL('./goal-bridge.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '@peer-agent/runtime-node'");
    expect(source).not.toContain('../../desktop/electron/main');
    expect(source).toContain("return pathOf('goalPlans')");
    expect(source).toContain('createGoalPlanStore({');
    expect(source).toContain('subscribeChanges: subscribeLocalChanges');
    expect(source).toContain('localChangeListeners');
    expect(source).toContain('store.setOnChange');
    expect(source).toContain('targetWorkspacePath: asString(options.args.targetWorkspacePath) || workspaceRoot');
    expect(source).not.toContain('findGoalPlanStorePath');
    expect(source).not.toContain('loadGoalPlanStoreFactory');
    expect(source).not.toContain('Unable to locate Desktop goal-plan-store.mjs');
  });


  test('notifies in-process subscribers immediately on goal_create_plan', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-notify-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const events: Array<Record<string, unknown>> = [];
      const unsubscribe = bridge.subscribeChanges((event) => {
        events.push(event as Record<string, unknown>);
      });
      try {
        const created = await bridge.execute({
          capabilityId: GOAL_TOOL_NAMES.createPlan,
          conversationId: 'conv-live-panel',
          mode: 'goal',
          workspaceRoot: process.cwd(),
          args: {
            title: 'Live panel',
            goal: 'Show goal panel as soon as the plan is created',
            tasks: [{ title: 'Notify subscribers on create' }],
          },
        });
        expect(created.result.status).toBe('success');
        const planId = (created.result.output as { planId?: string }).planId;
        expect(typeof planId).toBe('string');
        // Must observe the create event without waiting for turn-end / fs.watch.
        expect(events.some((event) => event.planId === planId)).toBe(true);
        expect(
          events.some((event) => event.planId === planId && event.conversationId === 'conv-live-panel'),
        ).toBe(true);
        const listed = bridge.listPlanDetailsByConversation('conv-live-panel');
        expect(listed.some((plan) => plan?.planId === planId)).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('creates a real shared store without injecting a mock store', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-static-'));
    try {
      // No `store` override: must construct via the static createGoalPlanStore import.
      const bridge = createTuiGoalBridge({ storeDir });
      const created = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-static-import',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: {
          title: 'Static import store',
          goal: 'Verify packaged CLI can create goal plans',
          tasks: [{ title: 'Create plan via embedded store' }],
        },
      });
      expect(created.result.status).toBe('success');
      const planId = (created.result.output as { planId?: string }).planId;
      expect(typeof planId).toBe('string');
      expect(bridge.getPlan(planId!).planId).toBe(planId);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('exposes Desktop-aligned goal tools and blocks shell during intake', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      expect(bridge.toolDefinitions.map((tool) => tool.name)).toEqual([
        GOAL_TOOL_NAMES.createPlan,
        GOAL_TOOL_NAMES.updateTask,
        GOAL_TOOL_NAMES.getPlan,
        GOAL_TOOL_NAMES.requestExplorer,
      ]);
      expect(
        bridge.toolDefinitions.find((tool) => tool.name === GOAL_TOOL_NAMES.requestExplorer)?.modeScopes,
      ).toEqual(['chat', 'goal']);

      const blocked = bridge.evaluateIntake({
        mode: 'goal',
        conversationId: 'conv-intake',
        capabilityId: 'local.shell.exec',
      });
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) {
        expect(blocked.reason).toContain('goal_create_plan');
      }

      const stopAllowed = bridge.evaluateIntake({
        mode: 'goal',
        conversationId: 'conv-intake',
        capabilityId: 'local.shell.stop',
      });
      expect(stopAllowed.allowed).toBe(true);

      const readAllowed = bridge.evaluateIntake({
        mode: 'goal',
        conversationId: 'conv-intake',
        capabilityId: 'local.file.read',
      });
      expect(readAllowed.allowed).toBe(true);

      const created = await bridge.execute({
        capabilityId: GOAL_CAPABILITY_IDS.create,
        conversationId: 'conv-intake',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: {
          title: 'Align CLI Goal',
          goal: 'Force intake then share goal store',
          tasks: [
            { title: 'Wire goal tools' },
            { title: 'Block shell until plan exists' },
          ],
        },
      });
      expect(created.result.status).toBe('success');
      const output = created.result.output as { planId?: string; status?: string };
      expect(typeof output.planId).toBe('string');
      expect(output.status).toBe('accepted');

      const after = bridge.evaluateIntake({
        mode: 'goal',
        conversationId: 'conv-intake',
        capabilityId: 'local.shell.exec',
      });
      expect(after.allowed).toBe(true);

      const listed = bridge.listPlansByConversation('conv-intake');
      expect(listed.length).toBeGreaterThan(0);
      expect(listed.some((plan) => plan?.planId === output.planId)).toBe(true);
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('request_explorer registers a structured Goal Runner request without executing it inline', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-explorer-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const result = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.requestExplorer,
        conversationId: 'conv-explorer',
        mode: 'goal',
        args: {
          question: 'Where is the capability projected?',
          reason: 'Confirm the runtime boundary',
          scope: { include: ['packages/runtime-node'], exclude: ['node_modules'] },
        },
      });
      expect(result.result.status).toBe('success');
      expect(result.result.output).toMatchObject({
        registered: true,
        question: 'Where is the capability projected?',
        reason: 'Confirm the runtime boundary',
        scope: { include: ['packages/runtime-node'], exclude: ['node_modules'] },
      });
      const invalid = await bridge.execute({
        capabilityId: GOAL_CAPABILITY_IDS.explore,
        conversationId: 'conv-explorer',
        mode: 'goal',
        args: { question: '   ' },
      });
      expect(invalid.result.status).toBe('failed');
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('goal_update_task and goal_get_plan read/write shared store', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-upd-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const created = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-update',
        mode: 'goal',
        args: {
          goal: 'Track task evidence',
          tasks: [{ taskId: 't1', title: 'First task' }],
        },
      });
      const planId = (created.result.output as { planId?: string }).planId;
      expect(planId).toBeTruthy();
      bridge.store.recordEvidenceRefs({
        planId,
        conversationId: 'conv-update',
        evidenceRefs: ['local-shell-artifact://demo'],
        toolCallId: 'shell-demo',
        capabilityId: 'local.shell.exec',
      });

      const updated = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.updateTask,
        conversationId: 'conv-update',
        mode: 'goal',
        args: {
          planId,
          taskId: 't1',
          status: 'completed',
          evidenceRefs: ['local-shell-artifact://demo'],
          result: 'done',
        },
      });
      expect(updated.result.status).toBe('success');

      const got = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.getPlan,
        conversationId: 'conv-update',
        mode: 'goal',
        args: { planId },
      });
      expect(got.result.status).toBe('success');
      const plan = (got.result.output as { plan?: any }).plan;
      expect(plan?.planId).toBe(planId);
      expect(plan?.tasks?.[0]).toMatchObject({
        taskId: 't1',
        status: 'completed',
        evidenceRefs: ['local-shell-artifact://demo'],
        result: 'done',
      });
      expect(plan?.progress).toMatchObject({ total: 1, completed: 1, percent: 100 });
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('projects the shared goal contract instead of a local-loose schema', () => {
    const bridge = createTuiGoalBridge({ storeDir: '/tmp/tui-goal-contract-probe' });
    const createPlan = bridge.toolDefinitions.find((tool: any) => tool.name === GOAL_TOOL_NAMES.createPlan) as any;

    // 回归点：TUI 曾把 title 声明为可选且无 description，模型漏传后 store 落成「未命名任务」。
    expect(createPlan.inputSchema.required).toContain('title');
    expect(typeof createPlan.inputSchema.properties.title.description).toBe('string');
    expect(createPlan.inputSchema.properties.title.description.length).toBeGreaterThan(0);
    expect(createPlan.inputSchema.additionalProperties).toBe(false);

    // 关系字段必须同时出现在 schema 与执行层，否则就是“看得见但不生效”。
    expect(createPlan.inputSchema.properties).toHaveProperty('parentPlanId');
    expect(createPlan.inputSchema.properties).toHaveProperty('sourceTaskId');

    // description 也来自共享契约，不再是 TUI 自己的一行简写。
    expect(String(createPlan.description)).toContain('Plan mode');
  });

  test('creates plans with a store-legal workflowKind in every mode', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-kind-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      // store 只接受 plan_approval / goal_self_driven；TUI 曾传非法值 'plan'。
      for (const [mode, expected] of [['plan', 'plan_approval'], ['goal', 'goal_self_driven']] as const) {
        const created: any = await bridge.execute({
          capabilityId: GOAL_TOOL_NAMES.createPlan,
          conversationId: `conv-kind-${mode}`,
          mode,
          workspaceRoot: process.cwd(),
          args: { title: `Kind ${mode}`, goal: 'workflowKind must be legal', tasks: [{ title: 't' }] },
        });
        expect(created.result.status).toBe('success');
        expect((created.result.output as any).plan.workflowKind).toBe(expected);
      }
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  test('derives parentPlanId/sourceTaskId for a follow-up but not for an explicit new request', async () => {
    const storeDir = await mkdtemp(path.join(tmpdir(), 'peer-tui-goal-rel-'));
    try {
      const bridge = createTuiGoalBridge({ storeDir });
      const store = (bridge as any).store ?? null;
      // 直接落一条已完成父计划：追问派生只认 completed 计划。
      const parent = store
        ? store.createPlan({
            conversationId: 'conv-rel',
            title: 'Parent',
            goal: 'parent goal',
            originWorkspacePath: process.cwd(),
            targetWorkspacePath: process.cwd(),
            tasks: [{ taskId: 'task-a', title: 'A' }],
            status: 'completed',
            workflowKind: 'goal_self_driven',
            createdBy: 'agent',
          })
        : null;

      expect(parent?.planId).toBeTruthy();

      const followUp: any = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-rel',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: { title: '继续打磨', goal: '在上一件事基础上再改一点', tasks: [{ title: 'B' }] },
      });
      const followed = (followUp.result.output as any).plan;
      expect(followed.parentPlanId).toBe(parent.planId);
      expect(followed.sourceTaskId).toBe('task-a');

      const explicitNew: any = await bridge.execute({
        capabilityId: GOAL_TOOL_NAMES.createPlan,
        conversationId: 'conv-rel-new',
        mode: 'goal',
        workspaceRoot: process.cwd(),
        args: { title: '新需求：完全无关的任务', goal: '另一件独立的事', tasks: [{ title: 'C' }] },
      });
      const fresh = (explicitNew.result.output as any).plan;
      expect(fresh.parentPlanId).toBeUndefined();
      expect(fresh.sourceTaskId).toBeUndefined();
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
