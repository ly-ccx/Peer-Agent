import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createGoalPlanStore } from '../../../packages/runtime-node/dist/goal-plan-store.mjs';
import { createSessionSupervisor } from '../../../packages/runtime-node/dist/project-agent/session-supervisor.mjs';
import { createDelegationProvider } from '../../../packages/runtime-node/dist/project-agent/delegation-provider.mjs';
import { createWorkCoordinationStore } from '../../../packages/runtime-node/dist/project-agent/work-coordination-store.mjs';
import { registerWorkBudget } from '../../../packages/runtime-node/dist/project-agent/work-budget.mjs';

/** Native host fixture for consumer integration tests; no model requests or shell execution. */
export async function readWithdrawnTaskSnapshots() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-withdrawn-consumer-'));
  const previous = process.env.PEER_AGENT_HOME;
  process.env.PEER_AGENT_HOME = root;
  let release = () => {};
  try {
    const conversationStore = createConversationStore({ storeDir: path.join(root, 'conversations') });
    const goalPlanStore = createGoalPlanStore({ storeDir: path.join(root, 'goal-plans') });
    const parent = conversationStore.createConversation({ title: 'Parent', role: 'project_agent', workspaceId: 'consumer-test', workspacePath: root });
    conversationStore.appendMessage(parent.id, { id: 'withdraw-now', role: 'user', kind: 'user_input', content: 'Withdraw this task; keep history' });
    const child = conversationStore.createConversation({ title: 'Old task', role: 'work_session', parentConversationId: parent.id, workspaceId: 'consumer-test', workspacePath: root });
    const plan = goalPlanStore.createGoalContract({ conversationId: child.id, goal: 'Old task', tasks: [{ taskId: 'old-leaf', title: 'Old leaf' }] });
    const selected = { providerId: 'local', modelId: 'unused', modelProviderId: 'unused', family: 'test' };
    goalPlanStore.revisePlan(plan.planId, { status: 'interrupted',
      tasks: plan.tasks.map(task => ({ ...task, status: 'failed', failureReason: 'conversation_persistence_failed' })),
      runner: { status: 'paused', interruption: { source: 'process_recovery', origin: 'host_handoff', reason: 'process_recovery', interruptedAt: '2026-10-29T02:51:53.227Z', recoverable: true, attempt: 1 } },
      delegationOrigin: { workspaceId: 'consumer-test', parentConversationId: parent.id, sessionId: 'old-session', workId: 'old-work',
        anchorMessageId: 'withdraw-now', inputId: 'withdraw-now', phase: 'paused', surface: 'desktop', depth: 1,
        modelSelection: { worker: selected, explorer: selected, verifier: selected, resolvedAt: '2026-10-29T02:00:00.000Z' },
        takeover: { operationId: 'old-takeover', phase: 'stopping', requestedAt: '2026-10-28T09:07:36.795Z' } } });
    const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'consumer-test', holdsLease: () => true, leaseEpoch: () => 'fixture' });
    const unknown = [{ toolCallId: 'unknown-bash', capabilityId: 'bash', planId: plan.planId, sessionId: 'old-session', attemptId: 'old-attempt' }];
    store.saveWork({ workId: 'old-work', parentConversationId: parent.id, state: 'cancelled', stopScope: 'work', budget: { uncertainDispatches: unknown, attempts: {} } });
    release = registerWorkBudget('consumer-test', store);
    const supervisor = createSessionSupervisor({ conversationStore, goalPlanStore, deferRecovery: true });
    const read = host => [host.get({ sessionId: 'old-session' }), ...host.list({ workspaceId: 'consumer-test' }),
      ...host.summaries({ workspaceId: 'consumer-test', all: true }), ...host.listByWorkspaceIds(['consumer-test']).get('consumer-test')];
    await supervisor.cancel({ sessionId: 'old-session' });
    const pending = read(supervisor);
    const tool = await createDelegationProvider({ supervisor }).executeCapability({ call: {
      capabilityId: 'local.delegation.control_work', toolCallId: 'withdraw',
      arguments: { sessionId: 'old-session', action: 'cancel', anchorMessageId: 'withdraw-now' },
    } }, { workspaceId: 'consumer-test', workspacePath: root, conversationId: parent.id, parentConversationId: parent.id,
      role: 'project_agent', mode: 'project_agent', surface: 'desktop', turnId: 'withdraw',
      currentInputAnchors: ['withdraw-now'], messages: conversationStore.getPersistedConversationHistory(parent.id).messages });
    assert.equal(tool.grant.granted, true);
    assert.equal(JSON.parse(tool.result.outputPreview.legacyResult.output).ok, true);
    const withdrawn = read(supervisor);
    // Model the old store's already-written record; recovery consumes the existing admitted input.
    goalPlanStore.revisePlan(plan.planId, { status: 'interrupted' });
    const cold = createGoalPlanStore({ storeDir: goalPlanStore.getStoreDir() });
    const restarted = createSessionSupervisor({ conversationStore, goalPlanStore: cold, deferRecovery: true });
    await restarted.recoverCancellations('consumer-test');
    for (let i = 0; i < 100 && (cold.getPlan(plan.planId).status !== 'cancelled' || cold.getPlan(plan.planId).delegationOrigin.cancellation.cleanupPending); i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(cold.getPlan(plan.planId).status, 'cancelled');
    assert.deepEqual(store.read().works['old-work'].budget.uncertainDispatches, unknown);
    return { pending, withdrawn, recovered: read(restarted) };
  } finally {
    release();
    if (previous === undefined) delete process.env.PEER_AGENT_HOME;
    else process.env.PEER_AGENT_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
