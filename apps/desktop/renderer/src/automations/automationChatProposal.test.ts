import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AutomationChatProposal,
  AutomationCreateContext,
  AutomationProposalActionResult,
} from '@peer-agent/protocol';
import {
  applyAutomationProposalActionResult,
  buildAutomationProposalActionRequest,
  projectAutomationChatProposal,
  selectAutomationChatProposal,
} from './automationChatProposal.ts';

function proposal(status: AutomationChatProposal['status']): AutomationChatProposal {
  return {
    schemaVersion: 1,
    proposalId: 'proposal-1',
    conversationId: 'conversation-1',
    fingerprint: 'fingerprint-1',
    source: 'chat_intent',
    confidence: 'high',
    status,
    definition: {
      name: 'Daily review',
      prompt: 'Review the workspace',
      workspacePath: '/workspace',
      schedule: { kind: 'daily', timezone: 'Asia/Shanghai', hour: 9, minute: 0 },
      grant: {
        preset: 'observe',
        workspacePath: '/workspace',
        allowedCapabilityIds: [],
        askCapabilityIds: [],
        blockedCapabilityIds: [],
        confirmedAt: '2026-08-05T09:00:00.000Z',
        version: 1,
      },
      notifications: { needsAttention: 'system_and_badge', failed: true, succeeded: false },
      budget: { timeoutMs: 1_800_000 },
      enable: true,
    },
    createdAt: '2026-08-05T09:00:00.000Z',
    updatedAt: '2026-08-05T09:00:00.000Z',
  };
}

test('projects canonical AutomationChatProposal lifecycle into card state', () => {
  assert.deepEqual(projectAutomationChatProposal(proposal('proposed')), {
    proposal: proposal('proposed'),
    canAct: true,
    isCreating: false,
    isTerminal: false,
    hasCreationReceipt: false,
  });
  assert.equal(projectAutomationChatProposal(proposal('creating')).canAct, false);
  assert.equal(projectAutomationChatProposal(proposal('failed')).canAct, true);
  assert.equal(projectAutomationChatProposal(proposal('cancelled')).isTerminal, true);

  const created = {
    ...proposal('created'),
    receipt: {
      schemaVersion: 1 as const,
      proposalId: 'proposal-1',
      fingerprint: 'fingerprint-1',
      conversationId: 'conversation-1',
      automationId: 'automation-1',
      automationName: 'Daily review',
      definitionVersion: 1,
      lifecycleStatus: 'active' as const,
      createdAt: '2026-08-05T09:01:00.000Z',
    },
  };
  assert.equal(projectAutomationChatProposal(created).hasCreationReceipt, true);
});

test('selects the active proposal without creating a renderer source of truth', () => {
  const active = proposal('proposed');
  const context: AutomationCreateContext = {
    schemaVersion: 1,
    kind: 'automation_create',
    source: 'chat_intent',
    status: 'proposed',
    activeProposal: active,
    rejectedFingerprints: [],
    createdAt: active.createdAt,
    updatedAt: active.updatedAt,
  };
  assert.equal(selectAutomationChatProposal(context), active);
  assert.equal(selectAutomationChatProposal(null), null);
});

test('builds a governed action request and rejects cross-conversation proposals', () => {
  const active = proposal('proposed');
  assert.deepEqual(buildAutomationProposalActionRequest('conversation-1', active, 'confirm'), {
    conversationId: 'conversation-1',
    proposalId: 'proposal-1',
    fingerprint: 'fingerprint-1',
    action: 'confirm',
  });
  assert.throws(
    () => buildAutomationProposalActionRequest('conversation-2', active, 'cancel'),
    /does not belong to the active conversation/,
  );
});

test('applies the authoritative proposal result back to conversation metadata', () => {
  const created = { ...proposal('created'), updatedAt: '2026-08-05T09:01:00.000Z' };
  const result: AutomationProposalActionResult = { proposal: created, replayed: false };
  const next = applyAutomationProposalActionResult(null, result);
  assert.equal(next.status, 'created');
  assert.equal(next.activeProposal, created);
  assert.equal(next.source, 'chat_intent');
  assert.deepEqual(next.rejectedFingerprints, []);
});
