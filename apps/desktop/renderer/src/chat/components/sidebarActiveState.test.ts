import assert from 'node:assert/strict';
import test from 'node:test';

import { sidebarActiveState, type SidebarPage } from './sidebarActiveState.ts';

const retainedConversationId = 'conversation-1';

function assertOnlyActive(page: SidebarPage, expected: keyof ReturnType<typeof sidebarActiveState>) {
  const state = sidebarActiveState(page, retainedConversationId, retainedConversationId);
  const activeEntries = Object.entries(state)
    .filter(([, active]) => active)
    .map(([name]) => name);

  assert.deepEqual(activeEntries, [expected]);
}

test('Chat activates only the retained conversation', () => {
  assertOnlyActive('chat', 'conversation');
});

test('Automation deactivates the retained conversation without clearing its id', () => {
  assertOnlyActive('automations', 'automations');
  assert.equal(retainedConversationId, 'conversation-1');
});

test('Settings deactivates the retained conversation and Automation', () => {
  assertOnlyActive('settings', 'settings');
});

test('Tools deactivates the retained conversation and Automation', () => {
  assertOnlyActive('tools', 'tools');
});

test('returning to Chat restores the retained conversation active state', () => {
  const duringAutomation = sidebarActiveState(
    'automations',
    retainedConversationId,
    retainedConversationId,
  );
  const afterReturn = sidebarActiveState('chat', retainedConversationId, retainedConversationId);

  assert.equal(duringAutomation.conversation, false);
  assert.equal(afterReturn.conversation, true);
});

test('Chat has no active conversation when the retained id does not match', () => {
  assert.deepEqual(sidebarActiveState('chat', retainedConversationId, 'conversation-2'), {
    conversation: false,
    automations: false,
    tools: false,
    settings: false,
  });
});
