import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { mergeBotActivity, visibleBotActivity, isActivityRunning } from './botActivityState.ts';
import { normalizeBotMessage } from './botConversationState.ts';
const activity: ProjectAgentActivity = { workspaceId: 'w', conversationId: 'c', turnId: 't', revision: 3,
  startedAt: '2026-10-04T01:00:00Z', phase: 'responding', replyTo: ['u'], segments: [], replyText: 'draft' };
test('late reattachment snapshots and other bots cannot rewind the live reply', () => {
  assert.equal(mergeBotActivity(activity, { ...activity, revision: 2 }, 'w'), activity);
  assert.equal(mergeBotActivity(activity, { ...activity, workspaceId: 'other', revision: 4 }, 'w'), activity);
  assert.equal(mergeBotActivity(activity, { ...activity, turnId: 'old', startedAt: '2026-10-03T00:00:00Z', revision: 90 }, 'w'), activity);
  assert.equal(isActivityRunning(activity), true);
  assert.equal(isActivityRunning({ ...activity, phase: 'stopped' }), false);
});
test('a canonical reply or stopped card replaces the preview without a duplicate', () => {
  const turn = normalizeBotMessage({ id: 't', kind: 'agent_turn', turnId: 't' })!;
  const reply = normalizeBotMessage({ id: 'r', kind: 'agent_reply', turnId: 't', content: 'final' })!;
  assert.equal(visibleBotActivity(activity, [turn]), activity);
  assert.equal(visibleBotActivity(activity, [turn, reply]), null);
  assert.equal(visibleBotActivity({ ...activity, phase: 'done' }, [turn]), null);
});
