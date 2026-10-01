import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDesktopProjectFacts } from './project-facts.mjs';

test('a started-task reply does not count as delivery of its completed result', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'peer-delivery-facts-'));
  let status = 'running';
  try {
    const facts = createDesktopProjectFacts({
      runtimeRoot: root,
      supervisor: {
        sessionsForProject: () => [{ sessionId: 's1', status: 'result_ready',
          origin: { anchorMessageId: 'input-1' } }],
        acceptance: () => null,
      },
      profileStore: { read: () => ({ agentConversationId: 'parent' }) },
      conversationStore: { getPersistedConversationHistory: () => ({ messages: [{
        kind: 'agent_reply', sources: ['s1'], meta: { sessionStates: [{ sessionId: 's1', status }] },
      }] }) },
    });
    assert.deepEqual(facts.delivery('w1').unreportedResults, [{ sessionId: 's1', anchorMessageId: 'input-1' }]);
    status = 'result_ready';
    assert.deepEqual(facts.delivery('w1').unreportedResults, []);
    status = 'accepted';
    assert.deepEqual(facts.delivery('w1').unreportedResults, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
