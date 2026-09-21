import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

// Regression reproducer: resolvable mechanical evidence is not an observation
// of the delivered UI. This test intentionally exposes the current false pass.
test('UI delivery: mechanical completion without artifact observation cannot claim artifact passed', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-ui-quality-'));
  const previousHome = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = path.join(root, '.peer-agent');
  t.after(() => {
    if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  });
  const store = createGoalPlanStore();
  const plan = store.createPlan({
    conversationId: 'ui-quality-reproducer',
    title: 'Fix the background panel layout',
    goal: 'The background panel must be visible and its stop action must work.',
    successCriteria: [],
    tasks: [{ taskId: 'change', order: 0, title: 'Change UI code', status: 'pending', evidenceRefs: [] }],
    deliveryBinding: {
      repoId: 'ui-fixture', targetBranch: 'test/ui', targetBranchSource: 'workspace_head',
      targetWorkspacePath: root, boundAt: '2026-09-15T00:00:00.000Z',
    },
  });
  store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
  const runner = createGoalRunner({
    goalPlanStore: store,
    chatRuntime: {
      async runGoalTurn({ planId }) {
        store.recordEvidenceRefs({
          planId, conversationId: plan.conversationId, streamId: 'mechanical',
          toolCallId: 'unit-test', toolName: 'bash',
          evidenceRefs: ['evidence://unit-test'], artifactRefs: [],
        });
        store.recordTaskEvidence(planId, 'change', {
          status: 'completed', evidenceRefs: ['evidence://unit-test'],
        });
        return {};
      },
    },
    logger: { warn() {} },
  });
  await runner.start(plan.planId, { awaitIdle: true });
  const result = store.getPlan(plan.planId);
  const artifactCheck = result.qualityReview?.checks?.find((check) => check.id === 'artifact');
  assert.notEqual(artifactCheck?.status, 'passed',
    'No preview, screenshot, interaction, or artifact judgment was produced');
});
