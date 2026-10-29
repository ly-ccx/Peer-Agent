import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNodeProviderBundle } from '../../../../../packages/runtime-node/src/provider-bundle.ts';
import { createProjectAgentRunner } from '../../../../../packages/runtime-node/src/project-agent/runner.mjs';
import { createProjectInbox } from '../../../../../packages/runtime-node/src/project-agent/project-inbox.mjs';
import { createWorkCoordinationStore } from '../../../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { createWorkBudgetGuard, registerWorkBudget } from '../../../../../packages/runtime-node/src/project-agent/work-budget.mjs';
import { createApprovalStore, createOneTimeApprovalBook, digestApprovalArgs, createPermissionGrant } from '@peer-agent/runtime-node';
import { createChatPermissionGate } from './permission-gate.mjs';

const timeout = { ok: false, error: 'connect timeout after 20000ms (ConnectTimeoutError)', retryable: false,
  providerRecovery: { kind: 'response_headers_timeout', retryable: true, exhausted: true, attempts: 4 } };
const before = { toolCallId: 'read-before-failure', name: 'read_file', capabilityId: 'local.file.read', arguments: { path: 'before.txt' } };
const after = { toolCallId: 'read-after-recovery', name: 'read_file', capabilityId: 'local.file.read', arguments: { path: 'after.txt' } };

function nativePair(call, execution) {
  return [{ role: 'assistant', tool_calls: [{ id: call.toolCallId, type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] },
  { role: 'tool', tool_call_id: call.toolCallId, content: JSON.stringify(execution) }];
}

function recoveryWorld(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-recovery-permission-'));
  const workspaceRoot = path.join(root, 'workspace');
  mkdirSync(workspaceRoot);
  writeFileSync(path.join(workspaceRoot, 'before.txt'), 'confirmed before failure');
  writeFileSync(path.join(workspaceRoot, 'after.txt'), 'NEW_READ_SENTINEL');
  const workspaceId = 'permission-recovery';
  const sessionId = 'permission-session';
  let clock = Date.parse('2026-10-10T06:00:00Z');
  const now = () => new Date(clock).toISOString();
  const storeOptions = { rootDir: path.join(root, 'runtime'), workspaceId, holdsLease: () => true, leaseEpoch: () => 'fixture-owner', now };
  let store = createWorkCoordinationStore(storeOptions);
  const inbox = createProjectInbox({ rootDir: path.join(root, 'runtime'), now });
  const approvalStore = createApprovalStore({ rootDir: path.join(root, 'runtime'), now: () => new Date(clock) });
  const oneTimeApprovals = createOneTimeApprovalBook({ ttlMs: 1000 });
  const activeStreams = new Map([['fixture-stream', { permissionIds: new Set(), turnProfile: { workspaceId, sessionId } }]]);
  const gate = createChatPermissionGate({ activeStreams, accessLevel: 'full_local', approvalStore, oneTimeApprovals, now: () => clock });
  const prompts = [], decisions = [], providerCalls = [], events = [], executions = [], profiles = [], messages = [];
  const timers = new Map();
  let timerId = 0, mode = 'goal';
  const webContents = { send(channel, payload) {
    if (channel !== 'chat:stream:permission-request') return;
    const call = payload.call;
    assert.equal(gate.settlePermissionRequest(call.toolCallId,
      createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId })), true);
  } };

  async function executeTurn({ turnProfile }) {
    profiles.push(turnProfile);
    const restored = turnProfile.providerCheckpoint;
    const call = restored ? after : before;
    const guard = createWorkBudgetGuard(turnProfile);
    const bundle = createNodeProviderBundle({ workspaceRoot, mode, shell: false, web: false, interaction: false, now,
      hookRunner: { runPreToolUse: () => [{ hookId: 'permission-fixture', decision: 'ask', reason: 'review local read' }] },
      requestPermission: async prompt => {
        prompts.push(prompt);
        const decision = await gate.createLocalCapabilityPermissionRequester({ webContents, streamId: 'fixture-stream',
          toolCallId: call.toolCallId, conversationId: 'conversation', workspacePath: workspaceRoot })(prompt);
        decisions.push(decision);
        return decision;
      },
    });
    const provider = bundle.providers.find(item => item.providerId === 'runtime-node.file');
    const execute = provider.execute;
    t.mock.method(provider, 'execute', async (request, context) => {
      providerCalls.push(request.toolCall.toolCallId);
      return execute(request, context);
    });
    bundle.events.subscribe(event => events.push(event));
    try {
      guard.beforeRequest({ accounting: 'physical_dispatch' });
      guard.beforeTool(call);
      const execution = await bundle.pipelineToolExecutor.execute(call, {
        run: { sessionId, conversationId: 'conversation', input: null }, turn: 1, index: 0, emit: () => null,
      });
      executions.push(execution);
      const native = { provider: 'openai', providerId: 'fixture-provider', model: 'fixture-model',
        messages: [...(restored?.messages || []), ...nativePair(call, execution.result)] };
      guard.checkpoint(native, [execution]);
      if (!restored) return { ...timeout, toolCalls: [{ toolCallId: call.toolCallId, name: call.name,
        input: call.arguments, result: JSON.stringify(execution.result) }] };
      return { text: execution.result.result.status === 'completed' ? 'Read completed.' : 'New read was denied.' };
    } finally {
      guard.finish({ totalTokens: 0, estimatedCostUsd: 0 });
      await bundle.dispose();
    }
  }
  const ports = { workspaceId, conversationId: 'conversation', inbox, executeTurn,
    appendMessage: (_id, message) => messages.push(message), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'fixture-provider' }), holdsLease: () => true, now, retryDelays: [],
    schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearSchedule: id => timers.delete(id) };
  let release = registerWorkBudget(workspaceId, store);
  let runner = createProjectAgentRunner({ ...ports, coordinationStore: store });
  t.after(() => { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); });
  return { gate, prompts, decisions, providerCalls, events, executions, profiles, approvalStore,
    get runner() { return runner; }, get store() { return store; },
    work: () => Object.values(store.read().works)[0],
    setMode: value => { mode = value; },
    rememberNextApproval() { return oneTimeApprovals.remember({ capabilityId: after.capabilityId,
      argsDigest: digestApprovalArgs(after.arguments), at: clock, sessionId, workspaceId }); },
    restart() {
      runner.dispose(); release();
      store = createWorkCoordinationStore(storeOptions);
      release = registerWorkBudget(workspaceId, store);
      runner = createProjectAgentRunner({ ...ports, coordinationStore: store });
    },
    async advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); await timer.fn(); } },
  };
}

for (const authority of ['valid', 'one-time', 'revoked', 'expired', 'unprojected']) {
  test(`durable recovery checks ${authority} authority through the production Node tool host`, async t => {
    const env = recoveryWorld(t);
    await env.runner.enqueueUserInputs([{ inputId: 'original-input', text: 'Read the two fixture files.' }]);
    const first = env.work();
    assert.equal(first.state, 'retry_wait');
    assert.ok(first.nativeCheckpointRef);
    assert.ok(first.recovery.reservationId);
    const native = env.store.readCheckpoint(first.nativeCheckpointRef);
    assert.equal(native.messages.length, 2);
    const oldExecution = JSON.parse(native.messages[1].content);
    assert.equal(oldExecution.result.permissionGrant.decision, 'allow');
    assert.equal(oldExecution.result.evidence.toolCallId, before.toolCallId);
    assert.deepEqual(env.providerCalls, [before.toolCallId]);

    if (['one-time', 'revoked', 'expired'].includes(authority)) env.gate.setAccessLevel('ask_before_local');
    if (authority === 'one-time' || authority === 'expired') assert.ok(env.rememberNextApproval().expiresAt);
    if (authority === 'unprojected') env.setMode('compact');
    env.restart();
    assert.equal(env.work().nativeCheckpointRef, first.nativeCheckpointRef);
    assert.equal(env.work().recovery.reservationId, first.recovery.reservationId);
    if (authority === 'one-time' || authority === 'revoked') assert.equal((await env.runner.retry(first.recovery.failedTurnId)).ok, true);
    else await env.advance(2000);

    assert.equal(env.profiles.length, 2);
    assert.equal(env.profiles[1].workId, env.profiles[0].workId);
    assert.deepEqual(env.profiles[1].providerCheckpoint, native);
    assert.equal(env.work().budget.modelRequests, 2);
    assert.equal(env.work().budget.toolCalls, 2);
    assert.deepEqual(env.work().budget.uncertainDispatches || [], []);
    const next = env.executions[1].result;
    assert.equal(next.result.toolCallId, after.toolCallId);
    assert.notEqual(next.result.evidence.evidenceId, oldExecution.result.evidence.evidenceId);
    assert.equal(next.result.evidence.toolCallId, after.toolCallId);
    assert.equal(JSON.stringify(next).includes('NEW_READ_SENTINEL'), authority === 'valid' || authority === 'one-time');
    if (authority === 'valid' || authority === 'one-time') {
      assert.deepEqual(env.providerCalls, [before.toolCallId, after.toolCallId]);
      assert.equal(next.result.status, 'completed');
      assert.equal(next.result.permissionGrant.decision, 'allow');
      assert.notEqual(next.result.permissionGrant.grantId, oldExecution.result.permissionGrant.grantId);
      assert.equal(env.prompts.length, 2);
      assert.equal(env.decisions[1].reason, authority === 'valid' ? 'local_access_level_full' : 'local_user_approved_once');
    } else {
      assert.deepEqual(env.providerCalls, [before.toolCallId]);
      assert.equal(next.result.status, 'denied');
      if (authority === 'unprojected') {
        assert.equal(next.result.error.code, 'capability_not_projected');
        assert.equal(env.prompts.length, 1);
      } else {
        assert.equal(env.prompts.length, 2);
        assert.equal(env.decisions[1].grant.granted, false);
        assert.equal(next.grant.granted, false);
        assert.notEqual(next.grant.grantId, env.decisions[0].grant.grantId);
        assert.equal(next.result.error.code, 'local_user_denied');
        assert.equal(env.approvalStore.list({ state: 'denied' }).length, 1);
        assert.deepEqual(env.events.filter(event => event.toolCallId === after.toolCallId
          && event.type.startsWith('permission.')).map(event => [event.type, event.decision]),
        [['permission.requested', 'ask'], ['permission.resolved', 'deny']]);
      }
    }
    const committed = env.store.readCheckpoint(env.work().nativeCheckpointRef);
    assert.deepEqual(committed.messages.slice(0, 2), native.messages);
    assert.equal(committed.messages[3].tool_call_id, after.toolCallId);
    assert.deepEqual(JSON.parse(committed.messages[3].content), JSON.parse(JSON.stringify(next)));
    await env.advance(5000);
    assert.equal(env.profiles.length, 2);
  });
}
