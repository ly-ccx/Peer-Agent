import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createConversationStore } from '@peer-agent/conversation-store';
import { createExecutionScheduler, createGoalPlanStore, createSessionSupervisor, createHostLease, createDelegationProvider } from '@peer-agent/runtime-node';
import { createScriptedTurnExecutor } from '@peer-agent/runtime-node/testing';
import { createProjectAgentHost } from '../project-agent-host.mjs';
import { createDesktopGoalRunnerHost } from '../../agent-host/goal-runner-host.mjs';
import { createAgentTurnExecutor } from '../../agent-host/agent-turn-executor.mjs';

const [root, killedPhase = ''] = process.argv.slice(2);
const setup = JSON.parse(readFileSync(path.join(root, 'fixture.json'), 'utf8'));
const workspaceId = 'ws-crash', runtimeRoot = path.join(root, 'project-runtime');
const conversations = createConversationStore({ storeDir: path.join(root, 'conversations') });
const plans = createGoalPlanStore({ storeDir: path.join(root, 'plans') });
const lease = createHostLease({ rootDir: runtimeRoot, hostId: `fixture-${process.pid}`, surface: 'desktop', staleMs: 1000, heartbeatMs: 20 });
const frozen = new Int32Array(new SharedArrayBuffer(4));
function checkpoint(phase) {
  if (phase !== killedPhase) return;
  process.send?.({ checkpoint: phase });
  // Parent kills only this fixture PID while the real store transition is suspended.
  Atomics.wait(frozen, 0, 0);
}
let host;
const scheduler = createExecutionScheduler({ rootDir: runtimeRoot });
scheduler.configure({ isWorkspaceReady: id => host?.isReady(id) === true });
const executor = createAgentTurnExecutor({ executionScheduler: scheduler, llmChatService: {
  async sendMessage() { return { requestedUserInput: true, terminalStatus: 'done' }; },
} });
const goalHost = createDesktopGoalRunnerHost({ goalPlanStore: plans, conversationStore: conversations,
  agentTurnExecutor: executor, hostLeases: lease, broadcast() {}, llmChatService: {},
  resolveConversationModelProviderId: () => 'worker', toDesktopProviderMessages: messages => messages,
  desktopContinuityContextFromProjection: () => [], workspaceRoot: setup.workspacePath, getMainWindows: () => [],
});
const model = { modelProviderId: 'worker', providerId: 'fixture', modelId: 'worker', family: 'f', tools: true, vision: true, contextTokens: 32_000 };
const supervisor = createSessionSupervisor({ goalPlanStore: plans, conversationStore: conversations,
  goalRunner: goalHost.goalRunner, executionScheduler: scheduler, deferRecovery: true, catalog: [model],
  canManageWorkspace: id => lease.holds(id), routing: { tiers: { strong: { primary: 'worker' }, vision: { primary: 'worker' } },
    roles: Object.fromEntries(['session_worker', 'explorer', 'verifier', 'visual_verifier'].map(role => [role, { mode: 'tier', tier: 'strong' }])) },
});
const provider = createDelegationProvider({ supervisor, storeDir: runtimeRoot });
host = createProjectAgentHost({ rootDir: runtimeRoot, holdsLease: id => lease.holds(id), acquireLease: id => lease.acquire(id),
  listWorkspaceIds: () => [workspaceId], resolveConversationId: () => setup.conversationId,
  hasMessage: (_id, messageId) => conversations.getPersistedConversationHistory(setup.conversationId)?.messages.some(message => message.id === messageId),
  readMessages: id => conversations.getPersistedConversationHistory(id)?.messages || [],
  appendMessage(id, message) { conversations.appendMessage(id, message); if (message.kind === 'user_input') checkpoint('input_written'); if (message.kind === 'agent_reply') checkpoint('reply_written'); },
  restoreQueue: id => supervisor.recoverQueue(id), recoverTasks: id => goalHost.goalRunner.recoverContextCheckpoints({ workspaceId: id, deferPump: true }),
  activateSessions: id => supervisor.resumeRecovered(id), onRecoveryPhase: ({ phase }) => checkpoint(phase),
  resolveModel: () => ({ modelProviderId: 'worker' }), getWindows: () => [],
  async executeTurn(input) {
    if (input.plan.kind !== 'user') return {};
    const recorded = [];
    const player = createScriptedTurnExecutor([
      { type: 'tool', name: 'spawn_session', input: {}, async executeTool() {
        const args = { anchorMessageIds: ['input-input-one'], title: 'One task', brief: 'Read the project once', kind: 'research', readOnly: true, successCriteria: ['Read'] };
        const result = await provider.executeCapability({ call: { toolCallId: `spawn-${input.turnId}`, capabilityId: 'local.delegation.spawn_session', arguments: args } },
          { mode: 'project_agent', role: 'project_agent', workspaceId, workspacePath: setup.workspacePath, conversationId: setup.conversationId,
            messages: conversations.getPersistedConversationHistory(setup.conversationId).messages, turnId: input.turnId, toolCallOrdinal: 1 });
        const output = JSON.parse(result.result.outputPreview.legacyResult.output);
        if (!output.sessionId) throw new Error(JSON.stringify(output));
        recorded.push({ name: 'spawn_session', input: args, result: output }); checkpoint('task_created'); return output;
      } },
      { type: 'delta', content: 'Task arranged once.' }, { type: 'terminal', channel: 'done' },
    ]);
    const outcome = await player.runTurn({ sink: input.sink, turnProfile: input.turnProfile });
    return { ...outcome, toolCalls: recorded };
  },
});
const result = await host.sync();
for (const meta of plans.listPlans()) await goalHost.goalRunner.waitForIdle(meta.planId);
const messages = conversations.getPersistedConversationHistory(setup.conversationId).messages;
process.send?.({ done: true, result, counts: { inputs: messages.filter(message => message.id === 'input-input-one').length,
  replies: messages.filter(message => message.kind === 'agent_reply').length, tasks: plans.listPlans().length },
  reply: messages.find(message => message.kind === 'agent_reply')?.content });
host.dispose(); lease.close(); process.disconnect?.();
