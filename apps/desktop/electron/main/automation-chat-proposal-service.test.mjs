import assert from 'node:assert/strict';
import test from 'node:test';

import {
  automationProposalFingerprint,
  createAutomationChatProposalService,
  createAutomationCreateContext,
} from './automation-chat-proposal-service.mjs';

function definition(overrides = {}) {
  return {
    name: 'Daily review',
    prompt: 'Review yesterday development progress',
    workspacePath: '/tmp/project',
    modelProviderId: null,
    schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
    grant: { localAccessLevel: 'workspace_write', allowedToolIds: [] },
    notifications: { onSuccess: true, onFailure: true, onAttention: true },
    budget: { timeoutMs: 600_000 },
    missedRunPolicy: 'run_latest',
    overlapPolicy: 'skip',
    enable: true,
    ...overrides,
  };
}

function harness() {
  const contexts = new Map();
  const created = [];
  let clock = 0;
  let ids = 0;
  const service = createAutomationChatProposalService({
    getContext: (id) => contexts.get(id) ?? null,
    saveContext: (id, context) => contexts.set(id, context),
    createAutomation: async (input) => {
      created.push(input);
      return {
        ...input,
        automationId: `automation-${created.length}`,
        version: 1,
        status: input.enable ? 'active' : 'draft',
        createdAt: '2026-08-05T00:00:10.000Z',
      };
    },
    now: () => `2026-08-05T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    createId: () => `proposal-${++ids}`,
  });
  return { contexts, created, service };
}

test('create context marks the strong automation-center entry without creating a definition', () => {
  const context = createAutomationCreateContext({
    source: 'automation_center',
    now: '2026-08-05T00:00:00.000Z',
  });
  assert.equal(context.kind, 'automation_create');
  assert.equal(context.source, 'automation_center');
  assert.equal(context.status, 'collecting');
  assert.equal(context.activeProposal, null);
});

test('proposal fingerprint is stable across object key order', () => {
  const first = definition();
  const second = { ...first, schedule: { minute: 0, hour: 9, timezone: 'Asia/Shanghai', kind: 'daily' } };
  assert.equal(automationProposalFingerprint(first), automationProposalFingerprint(second));
});

test('propose persists a structured proposal but does not create automation', () => {
  const { contexts, created, service } = harness();
  const result = service.propose({ conversationId: 'conversation-1', definition: definition() });
  assert.equal(result.proposal.status, 'proposed');
  assert.equal(result.proposal.definition.prompt, 'Review yesterday development progress');
  assert.equal(contexts.get('conversation-1').status, 'proposed');
  assert.equal(created.length, 0);
});

test('confirm creates once and clears the footer proposal after success', async () => {
  const { contexts, created, service } = harness();
  const proposed = service.propose({ conversationId: 'conversation-1', definition: definition() }).proposal;
  const request = {
    conversationId: 'conversation-1',
    proposalId: proposed.proposalId,
    fingerprint: proposed.fingerprint,
    action: 'confirm',
  };
  const first = await service.act(request);
  assert.equal(created.length, 1);
  assert.equal(first.receipt.automationId, 'automation-1');
  assert.equal(first.proposal.status, 'created');
  // Footer card is cleared after confirm while the terminal proposal remains durable for replay.
  assert.equal(contexts.get('conversation-1').status, 'created');
  assert.equal(contexts.get('conversation-1').activeProposal, null);
  assert.deepEqual(contexts.get('conversation-1').lastSettledProposal, first.proposal);
  const replay = await service.act(request);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.receipt, first.receipt);
  assert.equal(created.length, 1);
});

test('stale proposal card cannot create after a newer proposal replaces it', async () => {
  const { created, service } = harness();
  const first = service.propose({ conversationId: 'conversation-1', definition: definition() }).proposal;
  const second = service.propose({
    conversationId: 'conversation-1',
    definition: definition({ prompt: 'Review both repositories' }),
  }).proposal;
  assert.equal(second.replacesProposalId, first.proposalId);
  await assert.rejects(
    service.act({
      conversationId: 'conversation-1',
      proposalId: first.proposalId,
      fingerprint: first.fingerprint,
      action: 'confirm',
    }),
    /automation_proposal_stale/,
  );
  assert.equal(created.length, 0);
});

test('cancel stores rejected fingerprint and suppresses the same proposal in this conversation', async () => {
  const { contexts, created, service } = harness();
  const input = definition();
  const proposed = service.propose({ conversationId: 'conversation-1', definition: input }).proposal;
  const cancelled = await service.act({
    conversationId: 'conversation-1',
    proposalId: proposed.proposalId,
    fingerprint: proposed.fingerprint,
    action: 'cancel',
  });
  const repeated = service.propose({ conversationId: 'conversation-1', definition: input });
  assert.equal(cancelled.proposal.status, 'cancelled');
  assert.equal(repeated.suppressed, true);
  assert.equal(repeated.reason, 'rejected_fingerprint');
  assert.equal(created.length, 0);
  assert.equal(contexts.get('conversation-1').status, 'cancelled');
  assert.equal(contexts.get('conversation-1').activeProposal, null);
});

test('creation failure persists failed state and never fabricates a receipt', async () => {
  const contexts = new Map();
  const service = createAutomationChatProposalService({
    getContext: (id) => contexts.get(id) ?? null,
    saveContext: (id, context) => contexts.set(id, context),
    createAutomation: async () => { throw new Error('store_unavailable'); },
    now: () => '2026-08-05T00:00:00.000Z',
    createId: () => 'proposal-1',
  });
  const proposed = service.propose({ conversationId: 'conversation-1', definition: definition() }).proposal;
  await assert.rejects(
    service.act({
      conversationId: 'conversation-1',
      proposalId: proposed.proposalId,
      fingerprint: proposed.fingerprint,
      action: 'confirm',
    }),
    /store_unavailable/,
  );
  const failed = contexts.get('conversation-1').activeProposal;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.receipt, null);
  assert.equal(failed.automationId, null);
});
