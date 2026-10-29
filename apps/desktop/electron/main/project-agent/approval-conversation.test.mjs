import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApprovalStore } from '@peer-agent/runtime-node';
import { syncApprovalConversation } from './approval-conversation.mjs';

test('permission receipt is updated in place even when settled authority history compacts', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'permission-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const messages = [], appended = [], updated = [];
  const profile = { status: 'active', agentConversationId: 'parent-bot' };
  const conversationStore = {
    getPersistedConversationHistory(id) { assert.equal(id, 'parent-bot'); return { messages }; },
    updateMessageById(id, messageId, patch) { assert.equal(id, 'parent-bot'); updated.push(messageId); Object.assign(messages.find(row => row.id === messageId), patch); },
  };
  const store = createApprovalStore({ rootDir: root, compactBytes: 1, onChanged: ({ record }) => syncApprovalConversation({
    record, profile, conversationStore, appendMessage(id, message) { assert.equal(id, 'parent-bot'); messages.push(message); appended.push(message.id); },
  }) });
  const record = { approvalId: 'chat-permission:read', workspaceId: 'w', conversationId: 'worker', streamId: 'turn',
    capabilityId: 'local.image.read', state: 'open', summary: '/outside/screen.png', deadlineAt: '2026-10-11T11:00:00.000Z' };
  store.append(record); store.append(record);
  assert.equal(messages.length, 1); assert.equal(messages[0].kind, 'system_card'); assert.equal(messages[0].cards[0].actions.length, 4);
  store.append({ ...record, state: 'cancelled', decisionReason: 'permission_cancelled' });
  assert.equal(store.list().length, 0, 'settled tool authority may be compacted');
  assert.equal(appended.length, 1); assert.equal(updated.length, 1); assert.equal(messages[0].cards[0].resolution.state, 'cancelled');
  assert.equal(messages[0].cards[0].actions.length, 0);
});

test('untimed legacy approvals and deleted bots do not create synthetic history receipts', () => {
  const record = { approvalId: 'read', workspaceId: 'w', state: 'open' };
  const appendMessage = () => assert.fail('must not append');
  syncApprovalConversation({ record, profile: { status: 'active', agentConversationId: 'bot' }, appendMessage });
  syncApprovalConversation({ record: { ...record, deadlineAt: '2026-10-11T11:00:00.000Z' }, profile: { status: 'deleted', agentConversationId: 'bot' }, appendMessage });
});
