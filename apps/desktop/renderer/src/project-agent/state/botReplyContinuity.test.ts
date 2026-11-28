import assert from 'node:assert/strict';
import test from 'node:test';
import type { ProjectAgentActivity } from '@peer-agent/protocol';
import { applyOptimistic, conversationRows, normalizeBotMessage, type BotChatMessage, type ConversationDisplayRow, type PendingBotInput } from './botConversationState.ts';
import { attachBotProcesses, visibleBotActivity } from './botActivityState.ts';
import { awaitingInputAnswered, continuousReplyRows, conversationRowShowsAuthor, replyRowContains, replyRowMood, replyRowRunning, type BotReplyRow } from './botReplyContinuity.ts';
import { conversationRowKey } from './conversationWindow.ts';
import { userReceipt } from './userReceiptState.ts';
import { replyReferencesForRows } from './replyReferenceState.ts';
import { indexBotWork, threadTaskReferences } from './botWorkState.ts';
const at = '2026-10-22T00:00:00Z';
function message(id: string, kind: string, extra: Record<string, unknown> = {}) {
  return normalizeBotMessage({ id, kind, role: kind === 'user_input' ? 'user' : 'assistant', createdAt: at, ...extra })!;
}
const user = message('input-u', 'user_input', { inputId: 'u' });
const row = (message: ReturnType<typeof normalizeBotMessage>): ConversationDisplayRow => ({ type: 'message', message: message! });
function activity(extra: Partial<ProjectAgentActivity> = {}): ProjectAgentActivity {
  return { workspaceId: 'w', conversationId: 'c', turnId: 'turn', workId: 'work', startedAt: at, revision: 1,
    phase: 'thinking', replyTo: [user.id], segments: [], replyText: '', ...extra };
}
const userRow = (rows: ReturnType<typeof continuousReplyRows>, id: string) => {
  const input = rows.find(row => row.type === 'message' && row.message.id === id);
  assert.ok(input?.type === 'message');
  return input;
};
const replies = (rows: ReturnType<typeof continuousReplyRows>) => rows.filter((r): r is BotReplyRow => r.type === 'reply');
test('dispatch, completion and follow-up share the original inline task row', () => {
  const makeReply = (id: string, sources: string[]) => {
    const reply = message(id, 'agent_reply', { content: id, sources });
    return { type: 'reply', id, aliases: [id], replyTo: [], paragraphs: [], message: reply, messages: [reply] } satisfies BotReplyRow;
  };
  const dispatch = makeReply('dispatch', ['work']);
  const completion = makeReply('completion', ['work']);
  const followup = makeReply('followup', ['work', 'separate-work']);
  const resumed = { sessionId: 'work', status: 'running', followUpEpoch: 1, anchorMessageId: '', title: '原任务',
    statusLabel: '', spawnedAt: '', conversationId: '', modelLabel: '', summary: '', evidenceRefs: [], progress: '' };
  const owners = threadTaskReferences([dispatch, completion, followup], indexBotWork([resumed], true));
  assert.equal(owners.get(dispatch)?.[0]?.session, resumed);
  assert.equal(owners.has(completion), false);
  assert.deepEqual(owners.get(followup)?.map(task => task.id), ['separate-work']);
});

test('receipt stays on the input; public stream and final retain one carrier and original anchors', () => {
  const cache = new Map<string, string>();
  const waiting = continuousReplyRows([row(user)], [user], [{ inputId: 'u' }], [], cache);
  assert.deepEqual(replies(waiting), []);
  assert.equal(userRow(waiting, user.id).replyWait, 'waiting');
  const live = activity({ segments: [{ kind: 'text', id: 'opening', text: '先核对事实。' }] });
  const streaming = replies(continuousReplyRows([row(user), { type: 'activity', activity: live }], [user], [], [], cache))[0]!;
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' }, publicUpdates: [{ id: 'opening', text: '先核对事实。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '已完成。' });
  const finished = replies(continuousReplyRows([row(user), row(turn), row(final)], [user, turn, final], [], [], cache))[0]!;
  assert.equal(streaming.id, finished.id);
  // Delivered legacy records collapse to the canonical answer; the streamed text becomes process (ADR87 D7.3).
  assert.deepEqual(finished.paragraphs.map(p => p.text), ['已完成。']);
  assert.ok(replyRowContains(finished, 'turn')); assert.ok(replyRowContains(finished, 'final'));
  assert.equal(replyRowRunning(finished), false); assert.equal(replyRowMood(finished), 'idle');
});
test('incident shape: opening stays visible live, narration never bubbles, delivery shows the answer once (ADR87)', () => {
  const cache = new Map<string, string>();
  const opening = { kind: 'text' as const, id: 'text-1', role: 'opening' as const,
    text: '记下了：你的开发主分支就是 `kxt-ai-lab-initial-import`。我先把这件事记进项目事实，避免后面再把它当成普通功能分支。' };
  const narration = { kind: 'text' as const, id: 'text-2', role: 'narration' as const,
    text: '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，后面按这条分支理解。' };
  const answer = '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，仓库里对应的完整名字是 `feat/kxt-ai-lab-initial-import`。后面按这条分支理解。';
  const live = activity({ segments: [opening, narration] });
  const streaming = replies(continuousReplyRows([row(user), { type: 'activity', activity: live }], [user], [], [], cache))[0]!;
  assert.deepEqual(streaming.paragraphs.map(p => p.text), [opening.text]);
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' }, displayContract: 2,
    publicUpdates: [{ id: 'text-1', text: opening.text, role: 'opening' }, { id: 'text-2', text: narration.text, role: 'narration' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: answer });
  const finished = replies(continuousReplyRows([row(user), row(turn), row(final)], [user, turn, final], [], [], cache))[0]!;
  assert.deepEqual(finished.paragraphs.map(p => p.text), [answer]);
  assert.equal(finished.paragraphs[0]!.id, 'turn:conclusion');
});
test('legacy incident records collapse to the answer without guessing roles or comparing text (ADR87 D7.3)', () => {
  const turn = message('turn-9fbcf0ba', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' },
    publicUpdates: [
      { id: 'text-1', text: '记下了：你的开发主分支就是 `kxt-ai-lab-initial-import`。我先把这件事记进项目事实，避免后面再把它当成普通功能分支。' },
      { id: 'text-2', text: '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，后面按这条分支理解。' },
    ] });
  const final = message('reply-2', 'agent_reply', { turnId: 'turn-9fbcf0ba', replyTo: [user.id],
    content: '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，仓库里对应的完整名字是 `feat/kxt-ai-lab-initial-import`。后面按这条分支理解。' });
  const finished = replies(continuousReplyRows([row(user), row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(finished.paragraphs.map(p => p.text), [final.content]);
  // The persisted updates stay reachable for the process view; nothing is erased.
  assert.equal(finished.messages.length, 2);
});
test('restored unanswered input owns its waiting mark and does not invent running work', () => {
  const restored = continuousReplyRows([row(user)], [user], [], []);
  assert.deepEqual(replies(restored), []);
  assert.equal(userRow(restored, user.id).replyWait, 'waiting');
});
test('another input answer cannot clear this input wait', () => {
  const other = message('input-v', 'user_input', { inputId: 'v' });
  const final = message('reply-v', 'agent_reply', { replyTo: [other.id], content: '答复 v' });
  const result = continuousReplyRows([row(user), row(other), row(final)], [user, other, final], [{ inputId: 'u' }], []);
  assert.equal(userRow(result, user.id).replyWait, 'waiting');
  assert.deepEqual(replies(result).map(r => r.message?.id), [final.id]);
});
test('yielded attempts share public paragraphs while canonical later replies stay separate', () => {
  const first = message('first', 'agent_turn', { replyTo: [user.id], meta: { workId: 'work' }, publicUpdates: [{ id: 'a', text: '第一步' }] });
  const next = activity({ turnId: 'next', segments: [{ kind: 'text', id: 'b', text: '第二步' }] });
  const result = replies(continuousReplyRows([row(user), row(first), { type: 'activity', activity: next }], [user, first], [], []));
  assert.equal(result.length, 1); assert.deepEqual(result[0]!.paragraphs.map(p => p.text), ['第一步', '第二步']);
  const final = message('final', 'agent_reply', { turnId: 'first', replyTo: [user.id], content: '结论一' });
  const later = message('later', 'agent_reply', { turnId: 'first', replyTo: [user.id], content: '补充结论' });
  assert.equal(replies(continuousReplyRows([row(first), row(final), row(later)], [user, first, final, later], [], [])).length, 2);
});
test('canonical reuse of a public paragraph retains its node without duplicating text', () => {
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'a', text: '已完成。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '已完成。' });
  const result = replies(continuousReplyRows([row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(result.paragraphs, [{ id: 'turn:a', text: '已完成。' }]);
});
test('a refined legacy delivery collapses to the canonical answer without rewriting an earlier slot (ADR87 D7.3)', () => {
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [
    { id: 'text-1', text: '记下了：你的开发主分支就是 `kxt-ai-lab-initial-import`。我先把这件事记进项目事实，避免后面再把它当成普通功能分支。' },
    { id: 'text-2', text: '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，后面按这条分支理解。' },
  ] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id],
    content: '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，仓库里对应的完整名字是 `feat/kxt-ai-lab-initial-import`。后面按这条分支理解。' });
  const result = replies(continuousReplyRows([row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(result.paragraphs, [{ id: 'turn:conclusion', text: final.content }]);
  assert.equal(result.messages.length, 2);
});
test('a narrower delivered reply replaces the fuller streamed text in the reading column', () => {
  const streamed = '记下了。你的开发主分支就是 `kxt-ai-lab-initial-import`，后面按这条分支理解。';
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'a', text: streamed }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '记下了。' });
  const result = replies(continuousReplyRows([row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(result.paragraphs, [{ id: 'turn:conclusion', text: '记下了。' }]);
  assert.equal(result.messages.find(item => item.kind === 'agent_turn')?.publicUpdates?.[0]?.text, streamed);
});
test('exact reuse of an earlier paragraph does not leave a later streamed paragraph after delivery', () => {
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'a', text: '记下了。' }, { id: 'b', text: '去核对分支了。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: '记下了。' });
  const result = replies(continuousReplyRows([row(turn), row(final)], [user, turn, final], [], []))[0]!;
  assert.deepEqual(result.paragraphs, [{ id: 'turn:conclusion', text: '记下了。' }]);
  assert.equal(result.messages.find(item => item.kind === 'agent_turn')?.publicUpdates?.[1]?.text, '去核对分支了。');
});
test('delivery uncertainty keeps receipt without declaring active execution', () => {
  const result = continuousReplyRows([row(user)], [user], [{ inputId: 'u', deliveryIssue: true }], []);
  assert.deepEqual(replies(result), []);
  assert.equal(userRow(result, user.id).replyWait, 'deliveryIssue');
});
test('a later active attempt retires the old failure display but preserves its detail record', () => {
  const failed = message('failed', 'system_card', { turnId: 'old', replyTo: [user.id], cards: [{ cardId: 'failure', kind: 'agent_unavailable', title: '失败', body: '' }] });
  const before = JSON.stringify(failed);
  const result = replies(continuousReplyRows([row(failed), { type: 'activity', activity: activity() }], [user, failed], [], []))[0]!;
  assert.equal(result.message, undefined); assert.ok(result.messages.includes(failed)); assert.equal(JSON.stringify(failed), before);
  assert.equal(replyRowRunning(result), true);
});


test('an unknown local input has no invented reply or active execution placeholder', () => {
  const unknown = { ...user, pending: 'unknown' as const };
  const pending = [{ inputId: 'u', text: 'pending', quoteRefs: [], attachments: [], createdAt: at, state: 'unknown' as const }];
  const result = continuousReplyRows([row(unknown)], [unknown], [{ inputId: 'u' }], pending);
  assert.equal(replies(result).length, 0);
});

const received = [{ inputId: 'u', text: '你不知道 rc 40 是哪个分支打的包吗？', quoteRefs: [], attachments: [], createdAt: at, state: 'received' as const }];
const awaiting = [{ inputId: 'u' }];
function live(extra: Partial<ProjectAgentActivity> = {}): ProjectAgentActivity {
  return activity({ phase: 'waiting', replyText: '', segments: [], ...extra });
}
function project(messages: BotChatMessage[], current: ProjectAgentActivity | null, cache = new Map<string, string>()) {
  const history = attachBotProcesses(conversationRows(messages), messages, current);
  const visible = current ? visibleBotActivity(current, messages) : null;
  const rows: ConversationDisplayRow[] = visible ? [...history, { type: 'activity', activity: visible }] : history;
  return continuousReplyRows(rows, messages, awaiting, received, cache);
}
const authors = (rows: ReturnType<typeof project>) => rows.filter(conversationRowShowsAuthor);

test('first Activity, first token, streaming and done stay one bot row', () => {
  const prior = message('input-old', 'user_input', { inputId: 'old' });
  const earlier = message('old-reply', 'agent_reply', { replyTo: [prior.id], content: '上一轮已经回答过。' });
  const messages = [prior, earlier, user];
  const cache = new Map<string, string>();
  const pending = project(messages, null, cache);
  const waiting = project(messages, live(), cache);
  const thinking = project(messages, live({ phase: 'thinking' }), cache);
  const tool = project(messages, live({ phase: 'tool', segments: [{ kind: 'tool', id: 'read', name: 'read_file', status: 'running', summary: 'README.md' }] }), cache);
  const first = project(messages, live({ phase: 'responding', segments: [{ kind: 'text', id: 'text-1', text: '我先核对打包记录。' }] }), cache);
  const streaming = project(messages, live({ phase: 'responding', segments: [{ kind: 'text', id: 'text-1', text: '我先核对打包记录。rc.40 来自 PeerAgent/dev/0.1.0。' }] }), cache);
  const turn = message('turn', 'agent_turn', { replyTo: [user.id], publicUpdates: [{ id: 'text-1', text: '我先核对打包记录。rc.40 来自 PeerAgent/dev/0.1.0。' }] });
  const final = message('final', 'agent_reply', { turnId: 'turn', replyTo: [user.id], content: 'rc.40 是 PeerAgent/dev/0.1.0 打出来的。' });
  const done = continuousReplyRows(
    attachBotProcesses(conversationRows([prior, earlier, user, turn, final]), [prior, earlier, user, turn, final], null),
    [prior, earlier, user, turn, final], [], [], cache);
  assert.equal(userRow(pending, user.id).replyWait, 'waiting');
  assert.ok(!replies(pending).some(reply => reply.replyTo.includes(user.id)));
  for (const rows of [waiting, thinking, tool, first, streaming, done]) {
    const fresh = authors(rows).filter(row => row.type === 'reply' && row.replyTo.includes(user.id));
    assert.equal(fresh.length, 1, rows.map(row => row.type === 'reply' ? row.id : row.type).join(','));
  }
  const id = authors(waiting).filter(row => row.type === 'reply' && row.replyTo.includes(user.id))[0];
  assert.ok(id?.type === 'reply');
  for (const rows of [waiting, thinking, tool, first, streaming, done]) {
    const same = authors(rows).find(row => row.type === 'reply' && row.replyTo.includes(user.id));
    assert.equal(same?.type === 'reply' && same.id, id.id);
  }
  assert.equal(authors(done).find(row => row.type === 'reply' && row.id === id.id)?.type === 'reply'
    && authors(done).find(row => row.type === 'reply' && row.id === id.id) && true, true);
});

test('a long model wait, tool-only work, and reasoning with no text never stack a second avatar', () => {
  const messages = [user];
  const cases = [
    live({ replyTo: [] }),
    live({ replyTo: ['u'], phase: 'tool', segments: [{ kind: 'tool', id: 'read', name: 'read_file', status: 'running' }] }),
    live({ replyTo: ['input-other'], phase: 'thinking' }),
    live({ replyTo: [user.id], phase: 'waiting' }),
  ];
  for (const current of cases) {
    const rows = project(messages, current);
    assert.equal(authors(rows).length, 1, JSON.stringify(current.replyTo));
    assert.equal(rows.filter(row => row.type === 'reply').length, 1);
    const reply = rows.find(row => row.type === 'reply');
    assert.equal(reply?.type === 'reply' && replyRowRunning(reply), true);
    const matched = current.replyTo.some(id => id === 'u' || id === user.id);
    assert.equal(userRow(rows, user.id).replyWait, matched ? undefined : 'waiting');
  }
});

test('a user message id that is not input-${inputId} still shares the live row', () => {
  const custom = message('uuid-user', 'user_input', { inputId: 'u' });
  const rows = project([custom], live({ replyTo: [custom.id] }));
  assert.equal(authors(rows).length, 1);
  assert.equal(rows.filter(row => row.type === 'reply').length, 1);
});

test('an empty assistant body does not render a header, including beside a live reply', () => {
  const blank = message('blank', 'agent_reply', { content: '', replyTo: [] });
  assert.equal(conversationRowShowsAuthor({ type: 'message', message: blank }), false);
  const folded = replies(continuousReplyRows([row(blank)], [blank], [], []))[0]!;
  assert.equal(conversationRowShowsAuthor(folded), false);
  const rows = project([user, blank], live({ replyTo: [] }));
  const shown = authors(rows);
  assert.equal(shown.length, 1);
  const liveRow = shown[0];
  assert.ok(liveRow?.type === 'reply');
  if (liveRow?.type !== 'reply') return;
  assert.equal(replyRowRunning(liveRow), true);
});

test('alias spellings claim the same receipt without becoming extra quote anchors', () => {
  const rows = continuousReplyRows([row(user), { type: 'activity', activity: activity() }], [user], [{ inputId: 'u' }], []);
  const reply = replies(rows)[0]!;
  assert.equal(replies(rows).length, 1);
  assert.deepEqual(reply.replyTo, [user.id]);
  assert.deepEqual(replyReferencesForRows(rows).get(reply), []);
  const raw = continuousReplyRows([row(user), { type: 'activity', activity: activity({ replyTo: ['u'] }) }], [user], [{ inputId: 'u' }], []);
  const folded = replies(raw)[0]!;
  assert.equal(replies(raw).length, 1);
  assert.deepEqual(folded.replyTo, ['u']);
});

test('a delivered reply clears the awaited input whichever anchor spelling was stored', () => {
  const delivered = message('final', 'agent_reply', { replyTo: ['u'], content: '好' });
  assert.equal(awaitingInputAnswered([user, delivered], 'u'), true);
  assert.equal(awaitingInputAnswered([user], 'u'), false);
});

test('a historical input before a later agent_reply is never resurrected as an unconfirmed ghost row', () => {
  const older = message('input-old', 'user_input', { inputId: 'old', content: '跑检查' });
  const proactiveWake = message('reply-wake', 'agent_reply', { proactive: true, replyTo: [], content: '检查跑完了。' });
  const newer = message('input-new', 'user_input', { inputId: 'new', content: '咋样了？' });
  const liveForNewer = activity({ turnId: 'turn-new', replyTo: [newer.id], phase: 'thinking' });
  const all = [older, proactiveWake, newer];
  const rows = continuousReplyRows(
    [row(older), row(proactiveWake), row(newer), { type: 'activity', activity: liveForNewer }],
    all,
    [{ inputId: 'new' }],
    [{ inputId: 'new', text: '咋样了？', quoteRefs: [], attachments: [], createdAt: at, state: 'received' }],
  );
  const replyRows = replies(rows);
  assert.equal(replyRows.length, 2, 'only the delivered wake reply and the live reply for the new message should exist');
  assert.equal(userRow(rows, older.id).replyWait, undefined, 'a proactive reply bounds historical wait inference');
  const settled = replies(continuousReplyRows([row(older), row(proactiveWake)], [older, proactiveWake], [], []));
  assert.equal(settled.length, 1);
  assert.equal(settled[0]!.message?.id, proactiveWake.id);
});

test('a restored input waits on its bubble before and after an earlier retry ends', () => {
  const older = message('input-old', 'user_input', { inputId: 'old', content: '写方案' });
  const prevFailure = message('turn-fail-card', 'system_card', {
    turnId: 'turn-fail',
    replyTo: [older.id],
    cards: [{ cardId: 'card:agent_unavailable:turn-fail', kind: 'agent_unavailable', content: '失败', resolvedState: 'resolved' }],
  });
  const newer = message('input-new', 'user_input', { inputId: 'new', content: '？' });
  const liveForOlder = activity({ turnId: 'turn-older-retry', replyTo: [older.id], phase: 'thinking' });
  const all = [older, prevFailure, newer];
  const runningRows = continuousReplyRows(
    [row(older), row(prevFailure), row(newer), { type: 'activity', activity: liveForOlder }],
    all,
    [],
    [],
  );
  const runningReplies = replies(runningRows);
  assert.equal(runningReplies.length, 1, 'should not stack a second restored unconfirmed row while Bot is actively running');
  assert.equal(runningReplies[0]!.activity?.turnId, 'turn-older-retry');
  assert.equal(userRow(runningRows, newer.id).replyWait, 'waiting');

  // Smooth avatar mood stays on `thinking` when showToolMood is false (transient local tool).
  const transientToolReply: BotReplyRow = {
    ...runningReplies[0]!,
    activity: { ...liveForOlder, phase: 'tool' },
  };
  assert.equal(replyRowMood(transientToolReply, { showToolMood: false }), 'thinking');
  assert.equal(replyRowMood(transientToolReply, { showToolMood: true }), 'working');

  // Once no live activity is running, the unanswered restored input surfaces truthfully.
  const idleRows = continuousReplyRows([row(older), row(prevFailure), row(newer)], all, [], []);
  assert.deepEqual(replies(idleRows), []);
  assert.equal(userRow(idleRows, newer.id).replyWait, 'waiting');
});


const pendingInput = (inputId: string, state: PendingBotInput['state']): PendingBotInput => ({
  inputId, state, text: inputId, quoteRefs: [], attachments: [], createdAt: at,
});

test('A runs, B/C wait on their bubbles, then B starts and one reply answers B and C', () => {
  const a = message('input-a', 'user_input', { inputId: 'a' });
  const b = message('server-b', 'user_input', { inputId: 'b' });
  const c = message('server-c', 'user_input', { inputId: 'c' });
  const aTool = live({ turnId: 'turn-a', workId: 'work-a', phase: 'tool', replyTo: [a.id],
    segments: [{ kind: 'tool', id: 'read', name: 'read_file', status: 'running' }] });
  const pending = [pendingInput('b', 'received'), pendingInput('c', 'received')];
  const cache = new Map<string, string>();
  const view = (messages: BotChatMessage[], current?: ProjectAgentActivity, inputs: PendingBotInput[] = []) => {
    const shown = applyOptimistic(messages, inputs);
    const history = attachBotProcesses(conversationRows(shown), shown, current ?? null);
    const visible = visibleBotActivity(current ?? null, shown);
    return continuousReplyRows(visible ? [...history, { type: 'activity', activity: visible }] : history, shown, [], inputs, cache);
  };
  const running = view([a], aTool, pending);
  assert.deepEqual(replies(running).map(reply => reply.activity?.turnId), ['turn-a']);
  assert.equal(authors(running).length, 1);
  assert.equal(replyRowMood(replies(running)[0]!), 'working');
  for (const id of ['b', 'c']) {
    const bubble = userRow(running, `input-${id}`);
    assert.equal(bubble.message.content, id);
    assert.equal(userReceipt(bubble.message, false, bubble.replyWait).labelKey, 'projectAgent.chat.receivedWaiting');
  }

  const aFinal = message('answer-a', 'agent_reply', { turnId: 'turn-a', replyTo: [a.id], content: 'A done' });
  const betweenTurns = view([a, aFinal], undefined, pending);
  const reopened = view([a, b, c, aFinal]);
  for (const [rows, inputs] of [[betweenTurns, ['input-b', 'input-c']], [reopened, [b.id, c.id]]] as const) {
    assert.equal(replies(rows).length, 1);
    assert.ok(replies(rows).every(reply => !replyRowRunning(reply)));
    const bubbles = inputs.map(id => userRow(rows, id));
    assert.deepEqual(bubbles.map(bubble => bubble.replyWait), ['waiting', 'waiting']);
    assert.deepEqual(bubbles.map(conversationRowKey), ['input-b', 'input-c']);
  }

  const bActivity = live({ turnId: 'turn-b', workId: 'work-b', replyTo: ['b'] });
  const started = view([a, b, c, aFinal], bActivity);
  const liveB = replies(started).find(reply => reply.activity?.turnId === 'turn-b')!;
  assert.ok(replyRowRunning(liveB));
  assert.equal(liveB.id, 'reply-input-b');
  assert.equal(userRow(started, b.id).replyWait, undefined);
  assert.equal(userRow(started, c.id).replyWait, 'waiting');

  const combined = message('answer-bc', 'agent_reply', { turnId: 'turn-b', replyTo: [b.id, 'input-c'], content: 'B and C done' });
  const finished = view([a, b, c, aFinal, combined]);
  const reply = replies(finished).find(reply => reply.message?.id === combined.id)!;
  assert.equal(replies(finished).length, 2);
  assert.equal(reply.id, liveB.id);
  assert.deepEqual(reply.replyTo, [b.id, 'input-c']);
  assert.deepEqual(replyReferencesForRows(finished).get(reply), [b.id, c.id]);
  assert.ok(replyRowContains(userRow(finished, c.id), c.id), 'projected quote targets the rendered bubble');
  assert.equal(userRow(finished, b.id).replyWait, undefined);
  assert.equal(userRow(finished, c.id).replyWait, undefined);
});

test('failed or unconfirmed sends keep their retry input and only wait after receipt', () => {
  for (const [state, labelKey] of [['failed', 'projectAgent.chat.failed'], ['unknown', 'projectAgent.chat.inputUnconfirmed'],
    ['sending', 'projectAgent.chat.sending'], ['received', 'projectAgent.chat.receivedWaiting']] as const) {
    const pending = [pendingInput('retry-id', state)];
    const messages = applyOptimistic([], pending);
    const rows = continuousReplyRows(conversationRows(messages), messages, [], pending);
    const bubble = userRow(rows, 'input-retry-id');
    assert.deepEqual(replies(rows), []);
    assert.equal(conversationRowKey(bubble), 'input-retry-id');
    assert.equal(bubble.replyWait, state === 'received' ? 'waiting' : undefined);
    const mark = userReceipt(bubble.message, false, bubble.replyWait);
    assert.equal(mark.labelKey, labelKey);
    assert.equal(mark.retryInputId, state === 'failed' || state === 'unknown' ? 'retry-id' : undefined);
  }
});

test('rejected pending inputs never fabricate an active or restored reply row', () => {
  const rejected = { ...user, id: 'input-rej', inputId: 'rej', content: 'bad', pending: 'rejected' as const, rejectionCode: 'INVALID_INPUT' };
  const pending = [{ inputId: 'rej', text: 'bad', quoteRefs: [], createdAt: rejected.createdAt, state: 'rejected' as const, rejectionCode: 'INVALID_INPUT' }];
  const result = continuousReplyRows([row(rejected)], [rejected], [{ inputId: 'rej' }], pending);
  assert.equal(replies(result).length, 0);
});
