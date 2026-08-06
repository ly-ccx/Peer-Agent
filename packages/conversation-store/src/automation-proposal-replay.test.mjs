import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';

test('terminal automation proposal survives store restart for idempotent action replay', () => {
  const storeDir = mkdtempSync(join(tmpdir(), 'peer-automation-proposal-replay-'));
  try {
    const firstStore = createConversationStore({ storeDir });
    const conversation = firstStore.createConversation({ title: 'proposal replay', mode: 'chat' });
    const settledProposal = {
      proposalId: 'proposal-1',
      fingerprint: 'fingerprint-1',
      status: 'created',
      definition: { name: 'Daily review', prompt: 'Review the latest changes' },
      receipt: { automationId: 'automation-1', createdAt: '2026-08-06T10:00:00.000Z' },
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
    };

    firstStore.updateAutomationCreateContext(conversation.id, {
      source: 'automation-center',
      status: 'created',
      activeProposal: null,
      lastSettledProposal: settledProposal,
      rejectedFingerprints: [],
      createdAt: '2026-08-06T10:00:00.000Z',
      updatedAt: '2026-08-06T10:01:00.000Z',
    });

    const reopenedStore = createConversationStore({ storeDir });
    const reopened = reopenedStore.getConversation(conversation.id);
    assert.equal(reopened.automationCreateContext.activeProposal, null);
    assert.deepEqual(reopened.automationCreateContext.lastSettledProposal, settledProposal);
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }
});
