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

test('export basis is authorization and held refs, not a runTrace diary', () => {
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
          evidenceRefs: ['local-file://src/app.ts'],
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
          id: 'start-1',
          goalPlanId: 'plan-basis',
          type: 'action_started',
          summary: 'Goal Runner started',
          evidenceRefs: [],
          createdAt: '2026-08-22T00:11:00.000Z',
        },
        {
          id: 'fail-1',
          goalPlanId: 'plan-basis',
          type: 'problem_found',
          summary: 'Goal Runner failed: Model provider "openai" returned HTTP 503: <html><head><title>503 Service Temporarily Unavailable</title></head><body><center><h1>503</h1></center><hr><center>nginx</center></body></html>',
          evidenceRefs: [],
          createdAt: '2026-08-22T00:14:00.000Z',
        },
      ],
    },
  }));

  assert.equal(projected.authorization.planApproved, true);
  assert.equal(projected.authorization.approvedAt, '2026-08-22T00:10:00.000Z');
  assert.equal(projected.authorization.artifactCount, 1);
  assert.equal(projected.authorization.toolCount, 0);
  assert.equal(projected.authorization.denialCount, 0);
  assert.deepEqual(projected.events, []);
  assert.doesNotMatch(JSON.stringify(projected), /<html|nginx|Goal Runner|写完文件|测试红了/);
});

test('does not promote criterion claims into artifacts', () => {
  const projected = projectAcceptanceBasis(plan({
    criterionResults: [{
      criterionId: 'c1',
      passed: true,
      evidenceRef: 'model-said://done',
    }],
  }));
  assert.equal(projected.authorization.artifactCount, 0);
  assert.doesNotMatch(JSON.stringify(projected), /model-said/);
});

test('authorization summary stays plan approval and held artifacts', () => {
  assert.equal(
    formatAuthorizationSummary({
      planApproved: true,
      toolCount: 2,
      artifactCount: 1,
      denialCount: 0,
    }),
    '计划已批准 · 1 份产物',
  );
  assert.equal(
    formatAuthorizationSummary({
      planApproved: true,
      toolCount: 0,
      artifactCount: 0,
      denialCount: 1,
    }),
    '计划已批准',
  );
});
