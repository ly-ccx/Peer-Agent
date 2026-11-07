import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createConversationStore } from '../../../conversation-store/src/index.mjs';
import { createGoalPlanStore } from '../goal-plan-store.mjs';
import { createSessionSupervisor } from './session-supervisor.mjs';

const MODEL = { providerId: 'p', modelId: 'm', modelProviderId: 'mp', family: 'f' };

test('reconcile settles many completed plans without rereading the whole catalog each time', async () => {
  const count = 48;
  const dir = mkdtempSync(path.join(tmpdir(), 'reconcile-scale-'));
  const workspace = path.join(dir, 'workspace');
  mkdirSync(workspace);
  try {
    const plans = createGoalPlanStore({ storeDir: path.join(dir, 'goal-plans') });
    const conversations = createConversationStore({ storeDir: path.join(dir, 'conversations') });
    const conversation = conversations.createConversation({ role: 'project_agent', workspaceId: 'ws-1', title: 'bot' });
    for (let i = 0; i < count; i += 1) {
      const plan = plans.createPlan({
        title: 't', goal: 'g', conversationId: conversation.id, originWorkspacePath: workspace,
      });
      const nodes = i < 3 ? 400 : 4;
      plans.revisePlan(plan.planId, {
        status: 'completed',
        originWorkspacePath: workspace,
        delegationOrigin: {
          sessionId: `session-${i}`,
          workspaceId: 'ws-1',
          phase: 'running',
          parentConversationId: conversation.id,
          anchorMessageId: 'anchor',
          inputId: 'input',
          modelSelection: { worker: MODEL, explorer: MODEL, verifier: MODEL, resolvedAt: '2026-11-07T00:00:00.000Z' },
        },
        tasks: Array.from({ length: nodes }, (_, index) => ({
          taskId: `task-${i}-${index}`, title: 't', status: 'completed', updatedAt: '2026-11-07T03:00:00.000Z', result: 'ok', subtasks: [],
        })),
      });
    }
    let gets = 0;
    const read = plans.getPlan.bind(plans);
    plans.getPlan = (id) => { gets += 1; return read(id); };
    const supervisor = createSessionSupervisor({
      conversationStore: conversations,
      goalPlanStore: plans,
      deferRecovery: true,
      canManageWorkspace: () => true,
      autonomousCoordinationEnabled: () => false,
    });
    gets = 0;
    const started = performance.now();
    await supervisor.reconcile();
    const elapsed = performance.now() - started;
    // 48 completed plans used to reread the whole catalog once per plan: about (n + 9) * n reads.
    assert.ok(gets <= count * 4, `${gets} getPlan calls for ${count} plans in ${Math.round(elapsed)}ms`);
    assert.ok(elapsed < 500, `reconcile took ${Math.round(elapsed)}ms with ${gets} getPlan calls`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
