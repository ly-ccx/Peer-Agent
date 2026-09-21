import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoalPlanStore } from './goal-plan-store.mjs';
import { createGoalRunner } from './goal-runner.mjs';

for (const host of ['web', 'desktop']) {
  for (const mode of ['valid', 'missing', 'failed', 'stale', 'throws', 'non-ui']) {
    test(`${host}: Runner lifecycle with ${mode} local authority`, async (t) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'peer-ui-authority-'));
      const previousHome = process.env.PEER_AGENT_HOME;
      process.env.PEER_AGENT_HOME = root;
      t.after(() => {
        if (previousHome === undefined) delete process.env.PEER_AGENT_HOME;
        else process.env.PEER_AGENT_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      });
      const store = createGoalPlanStore();
      const plan = store.createPlan({ conversationId: 'authority-test', title: 'UI test', goal: 'Verify UI',
        successCriteria: [], tasks: [{ taskId: 'change', order: 0, title: 'Change', status: 'pending', evidenceRefs: [] }] });
      store.recordApproval(plan.planId, { decision: 'approve', decidedBy: 'test' });
      const r = { id: 'layout', host, requirementRevision: '1', buildFingerprint: 'build', instanceId: 'preview' };
      let reads = 0;
      let currentMode = mode;
      const runner = createGoalRunner({ goalPlanStore: store,
        uiDeliveryAuthority: { read(id) {
          assert.equal(id, plan.planId); reads++;
          if (currentMode === 'throws') throw new Error('unavailable');
          if (currentMode === 'missing') return null;
          if (currentMode === 'non-ui') return { required: false };
          return { required: true, requirements: [r], observations: [{ ...r,
            requirementId: r.id, buildFingerprint: currentMode === 'stale' ? 'old' : 'build',
            evidenceRef: 'observation', artifactHash: 'hash', admittedToRunId: 'run' }],
            judgments: [{ requirementId: r.id, observationRef: 'observation', evidenceRef: 'judgment',
              modelRunId: 'run', decision: currentMode === 'failed' ? 'failed' : 'passed' }] };
        } },
        chatRuntime: { async runGoalTurn({ planId }) {
          store.recordEvidenceRefs({ planId, conversationId: plan.conversationId, streamId: 'test',
            toolCallId: 'test', toolName: 'bash', evidenceRefs: ['mechanical', 'observation', 'judgment'], artifactRefs: [] });
          store.recordTaskEvidence(planId, 'change', { status: 'completed', evidenceRefs: ['mechanical'] });
          return {};
        } }, logger: { warn() {} },
      });
      await runner.start(plan.planId, { awaitIdle: true });
      assert.ok(reads > 0, 'actual Runner must read local authority');
      const got = store.getPlan(plan.planId);
      assert.equal(got.runner.status === 'completed', mode === 'valid' || mode === 'non-ui');
      if (!['valid', 'non-ui'].includes(mode)) assert.notEqual(got.status, 'completed');
      const reloaded = createGoalPlanStore().getPlan(plan.planId);
      assert.equal(reloaded.status, got.status, 'disk reload must preserve verification state');
      if (!['valid', 'non-ui'].includes(mode)) {
        currentMode = 'valid';
        await runner.start(plan.planId, { awaitIdle: true });
        assert.equal(store.getPlan(plan.planId).runner.status, 'completed', 'new valid evidence permits recovery');
      }
      if (mode !== 'non-ui') {
        currentMode = 'stale';
        await runner.start(plan.planId, { awaitIdle: true });
        assert.notEqual(store.getPlan(plan.planId).status, 'completed', 'rechecking stale evidence revokes completion');
      }
    });
  }
}
