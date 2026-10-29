import test from 'node:test';
import assert from 'node:assert/strict';
import { projectBotRecoveryStatus } from '@peer-agent/protocol';
import { recoveryConversationRows } from './recoveryConversationRows.ts';
import type { BotReplyRow } from './botReplyContinuity.ts';
const empty: BotReplyRow = { type: 'reply', id: 'reply:new', replyTo: ['input:new'], aliases: [], messages: [], paragraphs: [],
  pending: { since: '2026-10-28T01:11:57.227Z', sending: false, restored: false } };
test('blocked recovery keeps historical content and identities, without a blank assistant avatar', () => {
  const history = { ...empty, id: 'reply:old', paragraphs: [{ id: 'p', text: '已有成果' }] };
  const rows = [history, empty];
  assert.equal(recoveryConversationRows(rows, null), rows);
  assert.deepEqual(recoveryConversationRows(rows, projectBotRecoveryStatus('coordination_legacy_changed')), [history]);
  assert.equal(recoveryConversationRows(rows, projectBotRecoveryStatus('coordination_legacy_changed'))[0], history);
  assert.equal(rows.length, 2, 'presentation cannot delete original recovery identity or input');
});

test('stale activity cannot keep replying animation alive after recovery is blocked', async () => {
  const { replyPresenceState } = await import('./replyPresenceState.ts');
  const { createI18n } = await import('@peer-agent/i18n');
  const activity = { workspaceId: 'w', conversationId: 'c', turnId: 'old', revision: 1,
    startedAt: '2026-10-28T01:00:00Z', replyTo: ['input:new'], phase: 'thinking' as const, replyText: '已有进展', segments: [] };
  const current = { ...empty, activity, paragraphs: [{ id: 'kept', text: '已有进展' }] };
  const shown = recoveryConversationRows([current], projectBotRecoveryStatus('coordination_legacy_changed'))[0] as BotReplyRow;
  assert.equal(shown.activity, activity, 'do not fabricate or replace execution facts');
  assert.deepEqual(replyPresenceState(shown, createI18n('zh-CN')), { label: null, busy: false, refresh: false });
});
