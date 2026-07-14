import { describe, expect, test } from 'bun:test';

import {
  createPlanCoordinator,
  parseRuntimePlanText,
  planDecisionForKey,
  type RuntimePlan,
} from './plan-mode.ts';

const plan: RuntimePlan = {
  planId: 'plan-1',
  title: 'Ship safely',
  goal: 'Deliver the change without bypassing runtime governance.',
  tasks: [{ taskId: 'inspect', title: 'Inspect the runtime seam' }],
  successCriteria: [{ description: 'Tests pass' }],
};

describe('Plan Mode contract', () => {
  test('parses a structured plan from a fenced model response', () => {
    expect(parseRuntimePlanText(`Plan ready.\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``)).toEqual(plan);
    expect(parseRuntimePlanText('{"title":"missing fields"}')).toBeNull();
  });

  test('exposes the three plan decisions and keyboard shortcuts', () => {
    expect(planDecisionForKey('1', 2)).toBe('approve');
    expect(planDecisionForKey('2', 0)).toBe('revise');
    expect(planDecisionForKey('3', 0)).toBe('reject');
    expect(planDecisionForKey('escape', 0)).toBe('reject');
    expect(planDecisionForKey('enter', 1)).toBe('revise');
  });

  test('creates a goal only after explicit approval of the current plan id', async () => {
    const created: string[] = [];
    const coordinator = createPlanCoordinator({
      sessionId: 'session-a',
      goalExecution: { create: ({ plan: approved }) => { created.push(approved.planId); } },
    });
    coordinator.publish(plan);

    expect(await coordinator.decide('stale-plan', 'approve')).toBe(false);
    expect(created).toEqual([]);
    expect(await coordinator.decide(plan.planId, 'approve')).toBe(true);
    expect(created).toEqual([plan.planId]);
    expect(coordinator.getSnapshot()?.status).toBe('goal_created');
    expect(await coordinator.decide(plan.planId, 'approve')).toBe(false);
  });

  test('revise and reject have no goal side effects', async () => {
    let createCount = 0;
    const coordinator = createPlanCoordinator({
      sessionId: 'session-a',
      goalExecution: { create: () => { createCount += 1; } },
    });

    coordinator.publish(plan);
    expect(await coordinator.decide(plan.planId, 'revise')).toBe(true);
    expect(coordinator.getSnapshot()?.status).toBe('revising');
    expect(createCount).toBe(0);

    coordinator.publish({ ...plan, planId: 'plan-2' });
    expect(await coordinator.decide('plan-2', 'reject')).toBe(true);
    expect(coordinator.getSnapshot()?.status).toBe('rejected');
    expect(createCount).toBe(0);
  });

  test('isolates approvals between session coordinators', async () => {
    const created: string[] = [];
    const first = createPlanCoordinator({
      sessionId: 'session-a',
      goalExecution: { create: ({ sessionId }) => { created.push(sessionId); } },
    });
    const second = createPlanCoordinator({
      sessionId: 'session-b',
      goalExecution: { create: ({ sessionId }) => { created.push(sessionId); } },
    });
    first.publish(plan);
    second.publish({ ...plan, planId: 'plan-b' });

    expect(await first.decide('plan-b', 'approve')).toBe(false);
    expect(await second.decide('plan-b', 'approve')).toBe(true);
    expect(created).toEqual(['session-b']);
    expect(first.getSnapshot()?.status).toBe('awaiting_approval');
  });
});
