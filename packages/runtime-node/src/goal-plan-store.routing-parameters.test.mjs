import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGoalPlanStore } from './goal-plan-store.mjs';

test('persisted task model snapshots retain normal and fast channel choices', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-routing-freeze-'));
  try {
    for (const fastMode of [false, true]) {
      const store = createGoalPlanStore({ storeDir: dir });
      const model = { providerId: 'p', modelId: 'm', modelProviderId: 'm', family: 'p', reasoningEffort: 'high', fastMode };
      const planId = `plan-${fastMode}`;
      store.createPlan({ planId, title: 'Frozen routing', tasks: [], delegationOrigin: {
        workspaceId: 'w', sessionId: 's', parentConversationId: 'c', anchorMessageId: 'a', inputId: 'i', phase: 'queued',
        modelSelection: { worker: model, explorer: model, verifier: { ...model, sameFamilyAsWorker: true },
          source: { worker: 'global' }, resolvedAt: '2026-10-24T00:00:00Z' },
      } });
      const read = createGoalPlanStore({ storeDir: dir }).getPlan(planId);
      assert.equal(read.delegationOrigin.modelSelection.worker.fastMode, fastMode);
      assert.equal(read.delegationOrigin.modelSelection.worker.reasoningEffort, 'high');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
