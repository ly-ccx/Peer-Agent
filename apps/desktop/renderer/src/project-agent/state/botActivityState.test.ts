import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { attachBotProcesses, mergeBotActivity, visibleBotActivity, isActivityRunning } from './botActivityState.ts';
import { normalizeBotMessage, roundsForReply, conversationRows } from './botConversationState.ts';
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

test('stopped process reads only its exact canonical turn, even beside a newer round', () => {
  const turn = normalizeBotMessage({ id: 't', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'read_file', result: { ok: true } }] }] })!;
  const other = normalizeBotMessage({ id: 'other', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'bash', result: { ok: true } }] }] })!;
  const stopped = normalizeBotMessage({ id: 's', kind: 'system_card', turnId: 't', cards: [{ cardId: 's', kind: 'agent_stopped' }] })!;
  assert.deepEqual(roundsForReply([turn, other, stopped], 's'), turn.rounds);
  assert.deepEqual(roundsForReply([other, stopped], 's'), []);
});

test('inline history hands off to exact-turn tools before/after persistence without attaching another turn', () => {
  const old = normalizeBotMessage({ id: 'old', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'bash' }] }] })!;
  const reply = normalizeBotMessage({ id: 'r', kind: 'agent_reply', turnId: 't', content: 'final' })!;
  const messages = [old, reply];
  const pending = attachBotProcesses(conversationRows(messages), messages, activity).find(row => row.type === 'message');
  assert.equal(pending?.type, 'message');
  if (pending?.type !== 'message') throw Error('reply missing');
  assert.equal(pending.activity, activity); assert.deepEqual(pending.processRounds, []);
  const current = normalizeBotMessage({ id: 't', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'read_file' }] }] })!;
  const saved = [...messages, current];
  const historical = attachBotProcesses(conversationRows(saved), saved, null).find(row => row.type === 'message');
  if (historical?.type !== 'message') throw Error('reply missing');
  assert.equal(historical.activity, undefined); assert.deepEqual(historical.processRounds, current.rounds);
});
