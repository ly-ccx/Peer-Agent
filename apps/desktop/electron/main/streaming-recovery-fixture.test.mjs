import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProjectAgentRunner, createProjectInbox, registerWorkBudget, DEFAULT_WORK_BUDGET } from '@peer-agent/runtime-node';
import { createWorkCoordinationStore } from '../../../../packages/runtime-node/src/project-agent/work-coordination-store.mjs';
import { coordinationWorkId } from '../../../../packages/runtime-node/src/project-agent/work-coordination.mjs';
import { createAgentTurnExecutor } from './agent-host/agent-turn-executor.mjs';
import { createStreamingFixture, writeStreamingCommand } from '../../../../scripts/rc-response-interaction-smoke.mjs';

test('streaming fixture explicitly resumes a real native checkpoint without repeating the completed read', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-streaming-checkpoint-'));
  const now = () => '2026-10-10T06:00:00.000Z';
  const commandFile = path.join(root, 'command.json');
  writeStreamingCommand(commandFile, 'RC_STREAM_FAIL', 3);
  const records = [], messages = [], timers = [];
  const fixture = createStreamingFixture({ commandFile, record: (_kind, entry) => records.push(entry) });
  const executor = createAgentTurnExecutor({ llmChatService: fixture });
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId: 'fixture-workspace',
    holdsLease: () => true, leaseEpoch: () => 'fixture-owner', now });
  const release = registerWorkBudget('fixture-workspace', store);
  const runner = createProjectAgentRunner({ workspaceId: 'fixture-workspace', conversationId: 'fixture-conversation',
    inbox: createProjectInbox({ rootDir: root, now }), coordinationStore: store,
    appendMessage: (_id, message) => messages.push(message), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'fixture-provider', selection: { modelProviderId: 'fixture-provider',
      providerId: 'fixture-channel', modelId: 'fixture-model', family: 'openai' } }), holdsLease: () => true, now,
    schedule: (...args) => { timers.push(args); return timers.length; }, clearSchedule() {},
    executeTurn: input => executor.runTurn({ ...input,
      messages: [{ role: 'user', content: input.plan.userInputs.at(-1).text }] }),
  });
  t.after(() => { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); });
  await runner.enqueueUserInputs([{ inputId: 'fixture-input', text: 'RC_STREAM_FAIL' }]);
  const failed = Object.values(store.read().works)[0];
  assert.equal(failed.state, 'blocked_system');
  assert.equal(failed.recovery.failureKind, 'stream_interrupted');
  assert.equal(failed.recovery.retryable, false, 'partial output forbids automatic request replay');
  assert.equal(failed.recovery.reservationId, undefined);
  assert.ok(failed.nativeCheckpointRef);
  const native = store.readCheckpoint(failed.nativeCheckpointRef);
  assert.equal(native.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'read').length, 1);
  assert.equal(records.filter(entry => entry.role === 'project_agent').length, 1);
  await runner.retry(failed.recovery.failedTurnId);
  const completed = store.read().works[failed.workId];
  assert.equal(completed.state, 'delivered');
  assert.equal(completed.budget.modelRequests, 2);
  assert.equal(completed.budget.toolCalls, 2, 'one read and one post_reply');
  assert.equal(completed.budget.uncertainDispatches, undefined);
  assert.equal(records.filter(entry => entry.kind === 'streaming-read-dispatch').length, 1);
  assert.equal(records.filter(entry => entry.kind === 'streaming-recovery' && entry.nativePairLoaded).length, 1);
  assert.equal(messages.filter(message => message.kind === 'agent_reply').length, 1);
});

test('persisted blocked wake resumes its original native history and cumulative budget only after explicit retry', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-wake-checkpoint-'));
  const now = () => '2026-10-10T06:00:00.000Z';
  const workspaceId = 'wake-fixture-workspace', conversationId = 'wake-fixture-conversation';
  const turnId = 'rc-manual-wake-retry', eventId = 'rc-manual-retry-event';
  const event = { eventId, kind: 'session_verified', workspaceId, sessionId: 'rc-retry-session', at: now(), payload: {} };
  const workId = coordinationWorkId(conversationId, [eventId]);
  const recovery = { failureKind: 'response_headers_timeout', retryable: true, autoAttempts: 2,
    failedTurnId: turnId, deadlineAt: '2026-10-10T06:05:00.000Z' };
  const commandFile = path.join(root, 'command.json');
  writeStreamingCommand(commandFile, 'RC_MANUAL_WAKE_RETRY', 2);
  const records = [], messages = [{ id: turnId, turnId, kind: 'agent_turn', role: 'assistant', turnKind: 'wake',
    userInputs: [], content: '', rounds: [], meta: { workId } },
  { id: turnId + '-card', turnId, kind: 'system_card', role: 'assistant', card: 'agent_unavailable',
    content: 'response_headers_timeout: connect timeout after 20000ms (ConnectTimeoutError)', recovery, meta: { workId } }];
  const store = createWorkCoordinationStore({ rootDir: root, workspaceId,
    holdsLease: () => true, leaseEpoch: () => 'fixture-owner', now });
  store.transfer([event]);
  const job = { kind: 'wake', workId, turnId, userInputs: [], events: [event], throughSeq: 0, carried: [], continuation: true };
  const checkpointRef = store.checkpoint(workId, { job, outcome: { turnId, rounds: [], failed: true,
    reason: 'response_headers_timeout: connect timeout after 20000ms (ConnectTimeoutError)' } });
  const nativeCheckpointRef = store.checkpoint(workId + ':native', { provider: 'openai', providerId: 'fixture-provider',
    model: 'fixture-model', messages: [{ role: 'user', content: 'RC_MANUAL_WAKE_RETRY' }] });
  store.saveWork({ schemaVersion: 1, workspaceId, parentConversationId: conversationId, workId,
    state: 'blocked_system', end: 'provider_retryable', attemptId: turnId, anchorInputIds: [], sessionIds: [], waitFor: [],
    consumedEventIds: [eventId], pendingResultRefs: [], pendingEventIds: [eventId], checkpointRef, nativeCheckpointRef,
    stopScope: 'reply', recovery, budget: { modelRequests: 12, toolCalls: 0, tokens: 0, costUsd: 0,
      unknownUsage: true, unknownCost: true, attempts: {}, limits: DEFAULT_WORK_BUDGET } });
  const release = registerWorkBudget(workspaceId, store);
  const executor = createAgentTurnExecutor({ llmChatService: createStreamingFixture({ commandFile,
    record: (_kind, entry) => records.push(entry) }) });
  const runner = createProjectAgentRunner({ workspaceId, conversationId,
    inbox: createProjectInbox({ rootDir: root, now }), coordinationStore: store,
    appendMessage: (_id, message) => messages.push(message), readMessages: () => messages,
    resolveModel: () => ({ modelProviderId: 'fixture-provider', selection: { modelProviderId: 'fixture-provider',
      providerId: 'fixture-channel', modelId: 'fixture-model', family: 'openai' } }), holdsLease: () => true, now,
    executeTurn: input => executor.runTurn({ ...input, messages: [] }),
  });
  t.after(() => { runner.dispose(); release(); rmSync(root, { recursive: true, force: true }); });
  await runner.kick();
  assert.equal(records.length, 0, 'restart does not replay an exhausted blocked wake batch');
  assert.equal(store.read().works[workId].budget.modelRequests, 12);
  const receipt = await runner.retry(turnId);
  assert.equal(receipt.ok, true);
  const completed = store.read().works[workId];
  assert.equal(completed.state, 'delivered');
  assert.equal(completed.budget.modelRequests, 13, 'manual retry retains all earlier dispatches');
  assert.equal(completed.budget.toolCalls, 1);
  assert.equal(completed.budget.uncertainDispatches, undefined);
  assert.equal(store.read().events[eventId].handled, true);
  assert.equal(records.filter(entry => entry.kind === 'manual-wake-recovery' && entry.nativeLoaded).length, 1);
  assert.equal(messages.filter(message => message.kind === 'agent_reply').length, 1);
});
