import assert from 'node:assert/strict';
import test from 'node:test';
import type { GoalPlan } from './goal.ts';
import { formatAuthorizationSummary, projectAcceptanceBasis } from './acceptance-basis.ts';

function plan(overrides: Partial<GoalPlan> = {}): GoalPlan {
  return {
    planId: 'plan-basis',
    title: '依据',
    goal: '对照',
    status: 'completed',
    successCriteria: [],
    criterionResults: [],
    tasks: [],
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T01:00:00.000Z',
    ...overrides,
  } as GoalPlan;
}

test('projects grant, tool, artifact and denial into a readable basis', () => {
  const projected = projectAcceptanceBasis(plan({
    approval: {
      decision: 'approve',
      confirmationId: 'ok',
      decidedAt: '2026-08-22T00:10:00.000Z',
    },
    evidenceRefs: ['local-file://src/app.ts'],
    runTrace: {
      events: [
        {
          id: 'e1',
          goalPlanId: 'plan-basis',
          type: 'action_completed',
          summary: '写完文件',
          evidenceRefs: [],
          createdAt: '2026-08-22T00:20:00.000Z',
        },
        {
          id: 'e2',
          goalPlanId: 'plan-basis',
          type: 'validation_failed',
          summary: '测试红了一次',
          evidenceRefs: [],
          createdAt: '2026-08-22T00:30:00.000Z',
        },
        {
          id: 'e3',
          goalPlanId: 'plan-basis',
          type: 'message_routed',
          summary: '不进依据',
          evidenceRefs: [],
          createdAt: '2026-08-22T00:05:00.000Z',
        },
      ],
    },
  }));

  assert.equal(projected.authorization.planApproved, true);
  assert.equal(projected.authorization.toolCount, 1);
  assert.equal(projected.authorization.denialCount, 1);
  assert.equal(projected.authorization.artifactCount, 1);
  assert.deepEqual(projected.events.map((event) => event.kind), ['grant', 'tool', 'denial', 'artifact']);
  assert.doesNotMatch(projected.events.map((event) => event.title).join(','), /不进依据|Message routed/);
});

test('authorization summary stays one line', () => {
  assert.equal(
    formatAuthorizationSummary({
      planApproved: true,
      toolCount: 2,
      artifactCount: 1,
      denialCount: 0,
    }),
    '计划已批准 · 工具 2 · 产物 1',
  );
});
