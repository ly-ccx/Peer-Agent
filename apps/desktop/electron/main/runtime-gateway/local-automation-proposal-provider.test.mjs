import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOMATION_PROPOSAL_CAPABILITY_ID,
  createLocalAutomationProposalProvider,
} from './local-automation-proposal-provider.mjs';

const FIXED_NOW = '2026-08-05T00:00:00.000Z';

function call(argumentsValue = {}) {
  return {
    toolCallId: 'automation-proposal-call-1',
    capabilityId: AUTOMATION_PROPOSAL_CAPABILITY_ID,
    arguments: argumentsValue,
    argumentsPreview: argumentsValue,
    occurredAt: FIXED_NOW,
  };
}

function args(overrides = {}) {
  return {
    name: 'Daily review',
    prompt: 'Review yesterday development progress',
    schedule: { kind: 'daily', hour: 9, minute: 5 },
    confidence: 'high',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    locale: 'en-US',
    toolContext: {
      conversationId: 'conversation-1',
      workspacePath: '/real/workspace',
      ...overrides,
    },
  };
}

function providerWith(propose) {
  return createLocalAutomationProposalProvider({
    proposalService: { propose },
    resolveTimezone: () => 'Asia/Shanghai',
    now: () => FIXED_NOW,
  });
}

test('binds workspace and timezone locally instead of trusting model fields', async () => {
  let received = null;
  const provider = providerWith((input) => {
    received = input;
    return {
      suppressed: false,
      replayed: false,
      proposal: {
        schemaVersion: 1,
        proposalId: 'proposal-1',
        conversationId: input.conversationId,
        fingerprint: 'fingerprint-1',
        source: input.source,
        confidence: input.confidence,
        status: 'proposed',
        definition: input.definition,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    };
  });

  const execution = await provider.executeCapability({
    call: call(args({
      workspacePath: '/forged/workspace',
      timezone: 'Pacific/Honolulu',
      access: 'work_in_workspace',
      notifySuccess: true,
      timeoutMinutes: 45,
    })),
  }, context());

  assert.equal(execution.result.status, 'success');
  assert.equal(received.conversationId, 'conversation-1');
  assert.equal(received.source, 'chat_intent');
  assert.equal(received.definition.workspacePath, '/real/workspace');
  assert.equal(received.definition.grant.workspacePath, '/real/workspace');
  assert.equal(received.definition.schedule.timezone, 'Asia/Shanghai');
  assert.deepEqual(received.definition.grant.allowedCapabilityIds, [
    'local.file.read',
    'local.file.write',
    'local.shell.exec',
  ]);
  assert.equal(received.definition.notifications.succeeded, true);
  assert.equal(received.definition.budget.timeoutMs, 45 * 60_000);
  assert.equal(received.definition.grant.confirmedAt, FIXED_NOW);
});

test('proposal capability persists a proposal without creating an automation definition', async () => {
  let proposeCalls = 0;
  let createCalls = 0;
  const provider = providerWith((input) => {
    proposeCalls += 1;
    return {
      suppressed: false,
      replayed: false,
      proposal: {
        schemaVersion: 1,
        proposalId: 'proposal-2',
        conversationId: input.conversationId,
        fingerprint: 'fingerprint-2',
        source: input.source,
        confidence: input.confidence,
        status: 'proposed',
        definition: input.definition,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      },
    };
  });
  const forbiddenCreate = () => { createCalls += 1; };
  void forbiddenCreate;

  const execution = await provider.executeCapability({ call: call(args()) }, context());
  const output = JSON.parse(execution.result.output);

  assert.equal(proposeCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(output.ok, true);
  assert.equal(output.proposal.status, 'proposed');
  assert.equal(output.proposal.definition.enable, true);
  assert.equal(execution.result.mimeType, 'application/json');
  assert.equal(execution.result.evidence.dataLevel, 'D2_sensitive');
});

test('preserves rejected-fingerprint suppression from the proposal service', async () => {
  const provider = providerWith(() => ({
    suppressed: true,
    reason: 'rejected_fingerprint',
    proposal: null,
  }));

  const execution = await provider.executeCapability({ call: call(args()) }, context());
  const output = JSON.parse(execution.result.output);

  assert.equal(execution.result.status, 'success');
  assert.equal(output.suppressed, true);
  assert.equal(output.reason, 'rejected_fingerprint');
  assert.equal(output.proposal, null);
});

test('fails closed when conversation, workspace, or proposal service is missing', async () => {
  const provider = providerWith(() => assert.fail('propose must not be called'));
  const missingConversation = await provider.executeCapability(
    { call: call(args()) },
    context({ conversationId: null }),
  );
  assert.equal(missingConversation.result.status, 'failed');
  assert.match(missingConversation.result.outputPreview.error, /toolContext\.conversationId/);

  const missingWorkspace = await provider.executeCapability(
    { call: call(args()) },
    context({ workspacePath: '' }),
  );
  assert.equal(missingWorkspace.result.status, 'failed');
  assert.match(missingWorkspace.result.outputPreview.error, /toolContext\.workspacePath/);

  const unavailable = createLocalAutomationProposalProvider({ now: () => FIXED_NOW });
  const missingService = await unavailable.executeCapability({ call: call(args()) }, context());
  assert.equal(missingService.result.status, 'failed');
  assert.equal(missingService.result.outputPreview.error, 'automation_proposal_service_unavailable');
});

test('normalizes JSON arguments and safe defaults', async () => {
  let received = null;
  const provider = providerWith((input) => {
    received = input;
    return { suppressed: false, replayed: false, proposal: null };
  });
  const execution = await provider.executeCapability({
    call: call(JSON.stringify(args({ schedule: { kind: 'hourly' }, confidence: 'medium' }))),
  }, context());

  assert.equal(execution.result.status, 'success');
  assert.equal(received.confidence, 'medium');
  assert.equal(received.definition.schedule.everyHours, 1);
  assert.equal(received.definition.grant.preset, 'observe');
  assert.deepEqual(received.definition.grant.blockedCapabilityIds, [
    'local.file.write',
    'local.shell.exec',
  ]);
  assert.equal(received.definition.notifications.succeeded, false);
  assert.equal(received.definition.budget.timeoutMs, 30 * 60_000);
});
