import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createTuiGoalBridge, GOAL_CAPABILITY_IDS, GOAL_TOOL_NAMES } from './goal-bridge.ts';

describe('TuiGoalBridge', () => {
  test('statically imports Desktop createGoalPlanStore for packaged CLI', async () => {
    const source = await readFile(new URL('./goal-bridge.ts', import.meta.url), 'utf8');
    expect(source).toContain("from '../../desktop/electron/main/goal-plan-store.mjs'");
    expect(source).toContain("from '../../desktop/electron/main/data-store.mjs'");
    expect(source).toContain("return pathOf('goalPlans')");
    expect(source).toContain('createGoalPlanStore({');
    expect(source).toContain('subscribeChanges: (listener) => store.subscribeChanges(listener)');
    expect(source).not.toContain('findGoalPlanStorePath');
    expect(source).not.toContain('loadGoalPlanStoreFactory');
    expect(source).not.toContain('Unable to locate Desktop goal-plan-store.mjs');
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
      ]);

      const blocked = bridge.evaluateIntake({
        mode: 'goal',
        conversationId: 'conv-intake',
        capabilityId: 'local.shell.exec',
      });
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) {
        expect(blocked.reason).toContain('goal_create_plan');
      }

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
    } finally {
      await rm(storeDir, { recursive: true, force: true });
    }
  });
});
