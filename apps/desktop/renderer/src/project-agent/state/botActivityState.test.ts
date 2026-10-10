import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { attachBotProcesses, mergeBotActivity, visibleBotActivity, isActivityRunning } from './botActivityState.ts';
import { normalizeBotMessage, roundsForReply, conversationRows } from './botConversationState.ts';
const activity: ProjectAgentActivity = { workspaceId: 'w', conversationId: 'c', turnId: 't', revision: 3,
  startedAt: '2026-10-04T01:00:00Z', phase: 'responding', replyTo: ['u'], segments: [], replyText: 'draft' };

test('new input clears legacy process association without disturbing exact recovery or active turns', () => {
  const old = normalizeBotMessage({ id: 'old', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'read_file' }] }] })!;
  const input = normalizeBotMessage({ id: 'u', kind: 'user_input', content: '新的问题' })!;
  const legacy = normalizeBotMessage({ id: 'legacy', kind: 'agent_reply', content: '普通回复' })!;
  const rowsFor = (messages: NonNullable<ReturnType<typeof normalizeBotMessage>>[], live: ProjectAgentActivity | null = null) =>
    attachBotProcesses(conversationRows(messages), messages, live).filter(row => row.type === 'message');
  const unrelated = rowsFor([old, input, legacy]).find(row => row.type === 'message' && row.message.id === legacy.id);
  if (unrelated?.type !== 'message') throw Error('legacy reply missing');
  assert.deepEqual(unrelated.processRounds, [], 'old recovery tools never belong to the next input');
  const exact = normalizeBotMessage({ id: 'exact', kind: 'agent_reply', turnId: old.id, content: '恢复完成' })!;
  const recovered = rowsFor([old, input, exact]).find(row => row.type === 'message' && row.message.id === exact.id);
  if (recovered?.type !== 'message') throw Error('recovered reply missing');
  assert.deepEqual(recovered.processRounds, old.rounds, 'exact identity remains independent of order');
  const pending = normalizeBotMessage({ id: 'pending', kind: 'agent_reply', turnId: activity.turnId, content: '正在推进' })!;
  const active = rowsFor([old, input, pending], activity).find(row => row.type === 'message' && row.message.id === pending.id);
  if (active?.type !== 'message') throw Error('active reply missing');
  assert.equal(active.activity, activity); assert.deepEqual(active.processRounds, []);
  const current = normalizeBotMessage({ id: 'current', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'search_files' }] }] })!;
  const currentLegacy = rowsFor([old, input, current, legacy]).find(row => row.type === 'message' && row.message.id === legacy.id);
  if (currentLegacy?.type !== 'message') throw Error('current legacy reply missing');
  assert.deepEqual(currentLegacy.processRounds, current.rounds);
});

test('explicit wake retry keeps public paragraphs after persistence while automatic wake stays quiet', () => {
  const turn = normalizeBotMessage({ id: 't', kind: 'agent_turn', turnKind: 'wake', publicUpdates: [{ id: 'text-1', text: '正在重试。' }] })!;
  const reply = normalizeBotMessage({ id: 'r', kind: 'agent_reply', turnId: 't', content: '当前进展。' })!;
  const messages = [turn, reply];
  const row = attachBotProcesses(conversationRows(messages), messages, null).find(row => row.type === 'message');
  if (row?.type !== 'message') throw Error('reply missing');
  assert.equal(row.narration?.[0].text, '正在重试。');
  const quiet = normalizeBotMessage({ id: 't', kind: 'agent_turn', turnKind: 'wake', rounds: [{ text: 'PRIVATE_INTERNAL_TEXT' }] })!;
  const quietMessages = [quiet, reply];
  const quietRow = attachBotProcesses(conversationRows(quietMessages), quietMessages, null).find(row => row.type === 'message');
  if (quietRow?.type !== 'message') throw Error('reply missing');
  assert.deepEqual(quietRow.narration, []);
});
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
  const complete = attachBotProcesses(conversationRows(saved), saved, { ...activity, phase: 'done' }).find(row => row.type === 'message');
  if (complete?.type !== 'message') throw Error('reply missing');
  assert.equal(complete.activity, undefined, 'canonical completed timing replaces ephemeral fallback clocks');
  assert.deepEqual(complete.processRounds, current.rounds);
  for (const phase of ['stopped', 'error'] as const) {
    const interrupted = { ...activity, phase };
    const interruptedRow = attachBotProcesses(conversationRows(saved), saved, interrupted).find(row => row.type === 'message');
    if (interruptedRow?.type !== 'message') throw Error('reply missing');
    assert.equal(interruptedRow.activity, interrupted, 'interrupted activity preserves preparing calls that never dispatched');
  }
});
