import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutomationChatProposalService } from '../automation-chat-proposal-service.mjs';
import { createAutomationIpcRegistrations } from './register-automation-ipc.mjs';

test('Automation IPC has one owner and delegates every governed command', async () => {
  const calls = [];
  const port = (name) => async (payload) => { calls.push([name, payload]); return name; };
  const [registration] = createAutomationIpcRegistrations({ automations: {
    bootstrap: port('bootstrap'), list: port('list'), get: port('get'), create: port('create'),
    update: port('update'), listRuns: port('listRuns'), getRun: port('getRun'), runNow: port('runNow'),
    retryRun: port('retryRun'), cancelRun: port('cancelRun'), setRuntimePaused: port('setRuntimePaused'),
  }, proposals: {
    act: port('actOnProposal'),
  } });
  assert.equal(registration.owner, 'automations-ipc');
  const handlers = new Map();
  registration.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  const expected = [
    'automations:bootstrap', 'automations:list', 'automations:get', 'automations:create',
    'automations:update', 'automations:runs:list', 'automations:runs:get', 'automations:run-now',
    'automations:runs:retry', 'automations:runs:cancel', 'automations:runtime:set-paused',
    'automations:proposal:act',
  ];
  assert.deepEqual([...handlers.keys()], expected);
  const payload = { id: 'x' };
  await handlers.get('automations:bootstrap')({});
  for (const channel of expected.slice(1)) await handlers.get(channel)({}, payload);
  assert.deepEqual(calls.map(([name]) => name), [
    'bootstrap', 'list', 'get', 'create', 'update', 'listRuns', 'getRun', 'runNow',
    'retryRun', 'cancelRun', 'setRuntimePaused', 'actOnProposal',
  ]);
});

test('proposal confirmation crosses the Automation IPC owner and creates exactly once', async () => {
  const contexts = new Map();
  const created = [];
  const proposals = createAutomationChatProposalService({
    getContext: (conversationId) => contexts.get(conversationId) ?? null,
    saveContext: (conversationId, context) => contexts.set(conversationId, context),
    createAutomation: async (input) => {
      created.push(input);
      return {
        ...input,
        automationId: 'automation-through-ipc',
        version: 1,
        status: 'active',
        createdAt: '2026-08-05T00:00:01.000Z',
      };
    },
    now: () => '2026-08-05T00:00:00.000Z',
    createId: () => 'proposal-through-ipc',
  });
  const proposal = proposals.propose({
    conversationId: 'conversation-1',
    definition: {
      name: 'Daily review',
      prompt: 'Review progress',
      workspacePath: '/tmp/project',
      modelProviderId: null,
      schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
      grant: { localAccessLevel: 'workspace_write', allowedToolIds: [] },
      notifications: { onSuccess: true, onFailure: true, onAttention: true },
      budget: { timeoutMs: 600_000 },
      missedRunPolicy: 'run_latest',
      overlapPolicy: 'skip',
      enable: true,
    },
  }).proposal;
  const automations = {
    bootstrap() {}, list() {}, get() {}, create() {}, update() {}, listRuns() {}, getRun() {},
    runNow() {}, retryRun() {}, cancelRun() {}, setRuntimePaused() {},
  };
  const [registration] = createAutomationIpcRegistrations({ automations, proposals });
  const handlers = new Map();
  registration.register({ handle: (channel, handler) => handlers.set(channel, handler) });
  const request = {
    conversationId: 'conversation-1',
    proposalId: proposal.proposalId,
    fingerprint: proposal.fingerprint,
    action: 'confirm',
  };
  const first = await handlers.get('automations:proposal:act')({}, request);
  const replay = await handlers.get('automations:proposal:act')({}, request);
  assert.equal(created.length, 1);
  assert.equal(first.proposal.status, 'created');
  assert.equal(first.receipt.automationId, 'automation-through-ipc');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
});

test('Automation IPC rejects incomplete application ports', () => {
  assert.throws(() => createAutomationIpcRegistrations({ automations: {} }), /automations\.bootstrap/);
});
