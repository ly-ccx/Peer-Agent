import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createConversationStore } from './index.mjs';

test('runtime turn ledger keeps role and workspaceId when the caller has them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-ledger-role-'));
  try {
    const store = createConversationStore({ storeDir: dir });
    const conversation = store.createConversation({ title: 'role' });
    const recorded = store.recordRuntimeTurnUsage(conversation.id, {
      usage: {
        usageScope: 'runtime_turn',
        providerRequestCount: 1,
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      attribution: {
        id: 'turn-role',
        modelProviderId: 'provider-1',
        model: 'm',
        role: 'explorer',
        workspaceId: 'ws-1',
      },
    });
    assert.equal(recorded.ledgerRow.role, 'explorer');
    assert.equal(recorded.ledgerRow.workspaceId, 'ws-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
