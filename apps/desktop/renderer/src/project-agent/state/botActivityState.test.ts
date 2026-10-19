import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { attachBotProcesses, hasReplyForInput, mergeBotActivity, visibleBotActivity, isActivityRunning } from './botActivityState.ts';
import { normalizeBotMessage, roundsForReply, conversationRows } from './botConversationState.ts';
const activity: ProjectAgentActivity = { workspaceId: 'w', conversationId: 'c', turnId: 't', revision: 3,
  startedAt: '2026-10-04T01:00:00Z', phase: 'responding', replyTo: ['u'], segments: [], replyText: 'draft' };

test('received input and yielded internal records keep waiting until that input has a real reply or failure', () => {
  const messages = [
    normalizeBotMessage({ id: 'input-i', kind: 'user_input', inputId: 'i', content: '进展如何？' })!,
    normalizeBotMessage({ id: 'slice', turnId: 'slice', kind: 'agent_turn', replyTo: ['input-i'],
      publicUpdates: [{ id: 'text-1', text: '我先核对最新进展。' }] })!,
    normalizeBotMessage({ id: 'wake', kind: 'agent_turn', turnKind: 'wake', rounds: [{ text: 'INTERNAL_ONLY' }] })!,
    normalizeBotMessage({ id: 'other-reply', kind: 'agent_reply', replyTo: ['input-other'], content: '别的任务完成。' })!,
  ];
  assert.equal(hasReplyForInput(messages, 'i'), false);
  const reply = normalizeBotMessage({ id: 'answer', kind: 'agent_reply', replyTo: ['input-i'], content: '当前等待源码稳定。' })!;
  assert.equal(hasReplyForInput([...messages, reply], 'i'), true);
  assert.equal(hasReplyForInput([...messages, reply], 'new'), false);
  const failed = normalizeBotMessage({ id: 'failure', kind: 'system_card', turnId: 'slice', cards: [{ cardId: 'failed', kind: 'agent_unavailable' }] })!;
  assert.equal(hasReplyForInput([...messages, failed], 'i'), true, 'an anchored failure settles waiting without inventing a successful answer');
});

test('yielded public paragraphs remain visible through quiet wakes, without duplicating the live or canonical row', () => {
  const turn = normalizeBotMessage({ id: 't', turnId: 't', kind: 'agent_turn', turnKind: 'user',
    publicUpdates: [{ id: 'text-1', text: '我先核对最新进展。' }], rounds: [{ text: 'PRIVATE_LEGACY_TEXT' }] })!;
  const wake = normalizeBotMessage({ id: 'wake', kind: 'agent_turn', turnKind: 'wake', rounds: [{ text: 'PRIVATE_WAKE_TEXT' }] })!;
  const messages = [turn, wake];
  const rows = attachBotProcesses(conversationRows(messages), messages, null);
  const update = rows.find(row => row.type === 'message');
  assert.equal(update?.type, 'message');
  if (update?.type !== 'message') throw Error('public update missing');
  assert.equal(update.message.id, 't');
  assert.deepEqual(update.narration, turn.publicUpdates);
  assert.equal(rows.filter(row => row.type === 'message').length, 1);
  assert.equal(attachBotProcesses(conversationRows(messages), messages, activity).filter(row => row.type === 'message').length, 0,
    'the active preview owns its paragraph until its slice ends');
  const reply = normalizeBotMessage({ id: 'answer', kind: 'agent_reply', turnId: 't', content: '已核对。' })!;
  const answered = [...messages, reply];
  const delivered = attachBotProcesses(conversationRows(answered), answered, null).filter(row => row.type === 'message');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.id, 'answer');
  assert.deepEqual(delivered[0].narration, turn.publicUpdates);
  assert.equal(hasReplyForInput(messages, 'i'), false);
});

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

test('folded historical failures retain their canonical detail identity and original tool process', async () => {
  const { replyDetailsRow } = await import('./botActivityState.ts');
  const turn = normalizeBotMessage({ id: 't-old', kind: 'agent_turn', turnId: 't-old', rounds: [{ toolCalls: [{ name: 'verify_session', input: {}, result: { ok: false, error: 'verifier_timeout' } }] }] })!;
  const failure = normalizeBotMessage({ id: 't-old-card', kind: 'system_card', turnId: 't-old', content: '真实原始错误', cards: [{ cardId: 'failed', kind: 'agent_unavailable', content: 'verifier_timeout', actions: [] }] })!;
  const row = replyDetailsRow(failure.id, [], [turn, failure]);
  assert.equal(row?.type, 'message');
  if (row?.type !== 'message') return;
  assert.equal(row.message.id, failure.id);
  assert.equal(row.processRounds?.[0]?.toolCalls[0]?.name, 'verify_session');
  assert.equal(replyDetailsRow('absent', [], [turn, failure]), undefined);
});

test('a streaming details identity hands off to its canonical reply rather than the internal turn', async () => {
  const { replyDetailsRow } = await import('./botActivityState.ts');
  const turn = normalizeBotMessage({ id: 't-live', kind: 'agent_turn', turnId: 't-live', rounds: [{ toolCalls: [{ name: 'read_file', result: { ok: true } }] }] })!;
  const reply = normalizeBotMessage({ id: 'reply-live', kind: 'agent_reply', turnId: 't-live', content: 'Complete reply' })!;
  for (const rows of [[{ type: 'message' as const, message: reply }], []]) {
    const row = replyDetailsRow(turn.id, rows, [turn, reply]);
    assert.equal(row?.type, 'message');
    if (row?.type !== 'message') throw Error('reply missing');
    assert.equal(row.message.id, reply.id);
  }
});

test('targeted detail pages retain exact-turn interrupted Activity without borrowing another turn', async () => {
  const { replyDetailsFromPage } = await import('./botActivityState.ts');
  const messages = [
    { id: 't', kind: 'agent_turn', turnId: 't', rounds: [{ toolCalls: [{ name: 'read_file', input: { path: 'README.md' } }] }] },
    { id: 'stopped', kind: 'system_card', turnId: 't', cards: [{ cardId: 'stop', kind: 'agent_stopped' }] },
  ];
  for (const phase of ['stopped', 'error'] as const) {
    const interrupted = { ...activity, phase };
    const row = replyDetailsFromPage('projected-stop', { ok: true, processMessageId: 'stopped', messages, activity: interrupted });
    assert.equal(row?.type, 'message');if (row?.type !== 'message') throw Error('detail missing');
    assert.equal(row.activity, interrupted);
    assert.equal(row.processRounds?.[0].toolCalls[0].name, 'read_file');
  }
  const other = replyDetailsFromPage('stopped', { ok: true, messages, activity: { ...activity, turnId: 'other', phase: 'stopped' } });
  assert.equal(other?.type, 'message');if (other?.type !== 'message') throw Error('detail missing');
  assert.equal(other.activity, undefined);
  assert.equal(replyDetailsFromPage('stopped', { ok: false, messages, activity }), undefined);
});
