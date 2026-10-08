import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAutomationStore, createGoalPlanStore } from '@peer-agent/runtime-node';
import { seedUiAutomation, seedClassicUiFixture, sharedUiShots } from './shared-ui-convention-checks.mjs';

test('UI fixtures persist a paused receipt and an actual renamed Git file', t => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'peer-ui-fixture-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const classic = seedClassicUiFixture({ home });
  seedUiAutomation({ home, workspacePath: classic.workspacePath });
  const automations = createAutomationStore({ storeDir: path.join(home, 'automations') });
  assert.equal(automations.getDefinition('rc-ui-conventions').status, 'paused');
  assert.ok(automations.getRun('rc-ui-conventions-receipt').receipt.previousSummary);
  const plans = createGoalPlanStore({ storeDir: path.join(home, 'goal-plans') });
  const [plan] = plans.listPlanDetailsByConversation(classic.conversationId);
  assert.equal(plan.status, 'completed');
  assert.ok(plans.findEvidenceIndexRecords(plan.evidenceRefs)[0].userArtifacts[0].preview.diffLines.some(line => line === 'rename from old-name.ts'));
  assert.match(execFileSync('git', ['-C', classic.workspacePath, 'diff', '--find-renames', plan.baseCommit, 'HEAD'], { encoding: 'utf8' }), /rename to new-name.ts/);
  assert.equal(new Set(sharedUiShots).size, 16);
});
