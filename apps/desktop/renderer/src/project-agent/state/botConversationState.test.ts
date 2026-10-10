import assert from 'node:assert/strict';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  acknowledgeInput,
  applyOptimistic,
  conversationRows,
  conversationWindowAnchor,
  agentFailurePresentation,
  mergeConversationPage,
  normalizeBotMessage,
  quoteRefsFor,
  repliedUserIds,
  roundsForReply,
  showAgentThinking,
  visibleBotMessages,
  windowConversationRows,
  type BotChatMessage,
} from './botConversationState.ts';

test('legacy reply process cannot inherit a recovery turn across a new user input', () => {
  const old = normalizeBotMessage({ id: 'old-recovery', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'read_file', result: { ok: true } }] }] })!;
  const input = normalizeBotMessage({ id: 'new-user', kind: 'user_input', content: '新的问题' })!;
  const legacy = normalizeBotMessage({ id: 'legacy-reply', kind: 'agent_reply', content: '普通回复' })!;
  assert.deepEqual(roundsForReply([old, input, legacy], legacy.id), []);
  const exact = normalizeBotMessage({ ...legacy, id: 'exact-reply', turnId: old.id })!;
  assert.deepEqual(roundsForReply([old, input, exact], exact.id), old.rounds, 'explicit turn identity takes precedence over physical order');
  const current = normalizeBotMessage({ id: 'current', kind: 'agent_turn', rounds: [{ toolCalls: [{ name: 'search_files' }] }] })!;
  assert.deepEqual(roundsForReply([old, input, current, legacy], legacy.id), current.rounds, 'legacy records within the current input still retain their process');
});

test('failure presentation preserves typed host recovery and only promises a real reservation', () => {
  const raw = { id: 'failure', kind: 'system_card', cards: [{ cardId: 'failure', kind: 'agent_unavailable',
    content: '代理暂时不可用：connect timeout after 20000ms (ConnectTimeoutError)',
    recoveryWorkState: 'retry_wait', recovery: { failureKind: 'response_headers_timeout', retryable: true, autoAttempts: 1, failedTurnId: 'turn-1',
      reservationId: 'retry-1', retryAt: '2026-10-10T03:00:00.000Z', deadlineAt: '2026-10-10T03:05:00.000Z' } }] };
  const card = normalizeBotMessage(raw)!.cards[0]!;
  assert.equal(card.recovery?.reservationId, 'retry-1');
  assert.equal(agentFailurePresentation(card).messageKey, 'projectAgent.chat.recoveryScheduled');
  assert.equal(agentFailurePresentation({ ...card, recovery: { ...card.recovery!, reservationId: undefined } }).messageKey,
    'projectAgent.chat.recoveryExhausted');
  assert.equal(agentFailurePresentation({ ...card, recovery: undefined }).messageKey, 'projectAgent.chat.recoveryExhausted');
  assert.equal(agentFailurePresentation({ ...card, resolvedState: 'resolved' }).messageKey, 'projectAgent.chat.recoveryEnded');
  assert.equal(agentFailurePresentation({ ...card, recoveryWorkState: 'runnable', recovery: { ...card.recovery!, reservationId: undefined } }).recovering, true);
  assert.equal(agentFailurePresentation({ ...card, recoveryWorkState: 'blocked_system' }).recovering, false);
  assert.equal(agentFailurePresentation({ ...card, recoveryWorkState: undefined }).recovering, false);
});

test('host failure types override legacy diagnostics and unsafe retries remain unavailable', () => {
  const base = { cardId: 'failure', kind: 'agent_unavailable', content: 'connect timeout after 20000ms (ConnectTimeoutError)' };
  const recovery = { failureKind: 'authentication' as const, retryable: false, autoAttempts: 0, failedTurnId: 'turn-1' };
  assert.equal(agentFailurePresentation({ ...base, recovery }).messageKey, 'projectAgent.chat.recoveryAuthentication');
  assert.equal(agentFailurePresentation({ ...base, recovery, recoveryWorkState: 'runnable' }).messageKey, 'projectAgent.chat.recoveryContinuing');
  assert.equal(agentFailurePresentation({ ...base, recovery: { ...recovery, failureKind: 'execution_outcome_unknown' } }).messageKey,
    'projectAgent.chat.recoveryUnknownOutcome');
  assert.equal(agentFailurePresentation({ ...base, recovery: { ...recovery, failureKind: 'execution_outcome_unknown' } }).retryAllowed, false);
  assert.equal(agentFailurePresentation({ ...base, recovery: { ...recovery, failureKind: 'budget_exhausted' } }).messageKey,
    'projectAgent.chat.budgetExhausted');
  assert.equal(agentFailurePresentation({ ...base, recovery: { ...recovery, failureKind: 'permission' } }).messageKey,
    'projectAgent.chat.recoveryPermission');
  assert.equal(agentFailurePresentation({ ...base, recovery: { ...recovery, failureKind: 'stream_interrupted' } }).messageKey,
    'projectAgent.chat.recoveryExhausted');
});

test('malformed recovery payload cannot create a promise to recover or leak arbitrary details', () => {
  const card = normalizeBotMessage({ id: 'failure', cards: [{ cardId: 'f', kind: 'agent_unavailable', content: 'private diagnostic',
    recovery: { failureKind: 'invented', retryable: true, autoAttempts: -1, failedTurnId: 'turn', reservationId: 'fake', retryAt: 'bad date' } }] })!.cards[0]!;
  assert.equal(card.recovery, undefined);
  assert.deepEqual(agentFailurePresentation(card), { messageKey: 'projectAgent.chat.unavailable', recovering: false, retryAllowed: true });
});

test('missing durable continuation is explained without offering a replay', () => {
  const recovery = { failureKind: 'fatal', retryable: false, autoAttempts: 1, failedTurnId: 'turn-1',
    blockedCode: 'RECOVERY_CHECKPOINT_UNAVAILABLE' };
  const card = normalizeBotMessage({ id: 'failure', cards: [{ cardId: 'failure', kind: 'agent_unavailable',
    content: 'provider diagnostic', recoveryWorkState: 'blocked_system', recovery }] })!.cards[0]!;
  assert.deepEqual(card.recovery, recovery);
  assert.deepEqual(agentFailurePresentation(card), { messageKey: 'projectAgent.chat.recoveryMissingCheckpoint', recovering: false, retryAllowed: false });
  const invalid = normalizeBotMessage({ id: 'failure', cards: [{ ...card, recovery: { ...recovery, blockedCode: 'PRIVATE_DETAIL' } }] })!.cards[0]!;
  assert.deepEqual(invalid.recovery, { failureKind: 'fatal', retryable: false, autoAttempts: 1, failedTurnId: 'turn-1' });
});

test('durable receipt acknowledges its input and preserves identity until the canonical echo', () => {
  const pending = [{ inputId: 'a', text: 'body', quoteRefs: ['reply'], createdAt: 'now', state: 'sending' as const },
    { inputId: 'b', text: 'failed', quoteRefs: [], createdAt: 'now', state: 'failed' as const }];
  const acknowledged = acknowledgeInput(pending, 'a');
  assert.equal(acknowledged[0]!.state, 'received');
  assert.equal(acknowledged[1]!.state, 'failed');
  const shown = applyOptimistic([], acknowledged);
  assert.equal(shown[0]!.pending, 'received');
  assert.deepEqual(shown[0]!.dispositions, []);
  const echo = normalizeBotMessage({ id: 'input-a', role: 'user', inputId: 'a', content: 'body' });
  assert.ok(echo);
  assert.equal(applyOptimistic([echo], acknowledged).filter(item => item.inputId === 'a').length, 1);
});

function message(partial: Partial<BotChatMessage> & Pick<BotChatMessage, 'id' | 'kind' | 'createdAt'>): BotChatMessage {
  return {
    role: partial.kind === 'user_input' ? 'user' : 'assistant',
    content: partial.content ?? '',
    replyTo: partial.replyTo ?? [],
    sources: partial.sources ?? [],
    marks: partial.marks ?? [],
    meta: partial.meta ?? {},
    proactive: partial.proactive ?? false,
    cards: partial.cards ?? [],
    quoteRefs: partial.quoteRefs ?? [],
    separatorLabel: partial.separatorLabel ?? '',
    dispositions: [],
    rounds: [],
    ...partial,
  };
}

test('签收状态只读取宿主快照，不从回复正文推断', () => {
  const projected=normalizeBotMessage({id:'reply',role:'assistant',kind:'agent_reply',content:'已经签收',
    meta:{sessionStates:[{sessionId:'s1',status:'waiting_user'},{sessionId:'s2',status:'invented'}]}});
  assert.deepEqual(projected?.meta.sessionStates,[{sessionId:'s1',status:'waiting_user'}]);
  assert.deepEqual(normalizeBotMessage({id:'old',role:'assistant',kind:'agent_reply',content:'已经签收'})?.meta.sessionStates ?? [],[]);
});

test('按 kind 过滤，agent_turn 不显示，没有 kind 的用户消息仍显示', () => {
  const visible = visibleBotMessages([
    message({ id: 'u1', kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z', content: '你好' }),
    message({ id: 'turn', kind: 'agent_turn', createdAt: '2026-09-27T01:01:00.000Z', content: '内部回合不给用户看' }),
    message({ id: 'tool', kind: 'tool_result', createdAt: '2026-09-27T01:02:00.000Z', content: '工具原文' }),
    message({ id: 'card', kind: 'system_card', createdAt: '2026-09-27T01:03:00.000Z', content: '需要确认' }),
    message({ id: 'reply', kind: 'agent_reply', createdAt: '2026-09-27T01:04:00.000Z', content: '看过了' }),
  ]);
  const bare = normalizeBotMessage({ id: 'bare', role: 'user', content: '队列里的话', createdAt: '2026-09-27T01:05:00.000Z' });
  assert.ok(bare);
  assert.equal(bare?.kind, 'user_input');
  assert.deepEqual(visible.map((item) => item.id), ['u1', 'card', 'reply']);
  assert.equal(visibleBotMessages([bare!]).length, 1);
  assert.equal(normalizeBotMessage({ role: 'assistant', content: '没有 id' }), null);
  const shot = normalizeBotMessage({
    id: 'shot',
    role: 'user',
    content: 'Appshot — TextEdit',
    attachments: [{ id: 'att-1', kind: 'image', name: 'shot', dataUrl: 'data:image/png;base64,AA==' }],
  });
  assert.equal(shot?.images?.[0]?.dataUrl, 'data:image/png;base64,AA==');
});

test('分页合并把更早的页放前面，同一条用新内容替换', () => {
  const first = [
    message({ id: 'm2', kind: 'user_input', createdAt: '2026-09-27T02:00:00.000Z', content: '旧' }),
  ];
  const older = [
    message({ id: 'm1', kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z', content: '更早' }),
  ];
  const newer = [
    message({ id: 'm2', kind: 'user_input', createdAt: '2026-09-27T02:00:00.000Z', content: '新' }),
    message({ id: 'm3', kind: 'agent_reply', createdAt: '2026-09-27T02:05:00.000Z', content: '回复' }),
  ];
  const merged = mergeConversationPage(mergeConversationPage(first, older), newer);
  assert.deepEqual(merged.map((item) => [item.id, item.content]), [
    ['m1', '更早'],
    ['m2', '新'],
    ['m3', '回复'],
  ]);
});

test('乐观发送在服务端回声后被替换，失败的仍留在列表里', () => {
  const pending = [{
    inputId: 'in-1',
    text: '在发送',
    quoteRefs: ['reply-1', '那一句'],
    createdAt: '2026-09-27T03:00:00.000Z',
    state: 'sending' as const,
  }, {
    inputId: 'in-2',
    text: '失败了',
    quoteRefs: [],
    createdAt: '2026-09-27T03:01:00.000Z',
    state: 'failed' as const,
  }];
  const shown = applyOptimistic([], pending);
  assert.deepEqual(shown.map((item) => item.id), ['input-in-1', 'input-in-2']);
  assert.equal(shown[0]?.pending, 'sending');
  const echoed = applyOptimistic([
    message({
      id: 'input-in-1',
      kind: 'user_input',
      createdAt: '2026-09-27T03:00:00.000Z',
      content: '在发送',
      inputId: 'in-1',
    }),
  ], pending);
  assert.deepEqual(echoed.map((item) => item.id), ['input-in-1', 'input-in-2']);
  assert.equal(echoed[0]?.pending, undefined);
  assert.equal(echoed[1]?.pending, 'failed');
});

test('间隔超过 10 分钟或主动消息才插入时间分隔', () => {
  const rows = conversationRows([
    message({ id: 'a', kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z' }),
    message({ id: 'b', kind: 'agent_reply', createdAt: '2026-09-27T01:05:00.000Z', replyTo: ['a'] }),
    message({ id: 'c', kind: 'user_input', createdAt: '2026-09-27T01:16:00.000Z' }),
    message({
      id: 'd',
      kind: 'agent_reply',
      createdAt: '2026-09-27T01:17:00.000Z',
      proactive: true,
      separatorLabel: '今天 09:17 · 今日小结',
    }),
    message({ id: 'hidden', kind: 'agent_turn', createdAt: '2026-09-27T01:18:00.000Z', content: '不进分隔' }),
  ]);
  assert.deepEqual(rows.map((row) => row.type === 'separator' ? `sep:${row.label || row.at}` : row.message.id), [
    'a',
    'b',
    'sep:2026-09-27T01:16:00.000Z',
    'c',
    'sep:今天 09:17 · 今日小结',
    'd',
  ]);
  assert.equal(repliedUserIds(visibleBotMessages([
    message({ id: 'a', kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z' }),
    message({ id: 'b', kind: 'agent_reply', createdAt: '2026-09-27T01:05:00.000Z', replyTo: ['a'] }),
  ])).has('a'), true);
});

test('超过 200 行时只留锚点附近的窗口', () => {
  const short = Array.from({ length: 40 }, (_item, index) => index);
  assert.equal(windowConversationRows(short, 10).rows.length, 40);
  const rows = Array.from({ length: 250 }, (_item, index) => index);
  const early = windowConversationRows(rows, 10, 80);
  assert.equal(early.rows.length, 80);
  assert.equal(early.start, 0);
  assert.equal(early.rows.includes(240), false);
  const late = windowConversationRows(rows, 240, 80);
  assert.equal(late.rows.at(-1), 249);
  assert.equal(late.rows.includes(10), false);
});

test('loading earlier pages retains the same reading anchor beyond the window threshold', () => {
  const rows = conversationRows(Array.from({ length: 300 }, (_, i) => message({ id: `m-${i + 50}`, kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z' })));
  const older = conversationRows(Array.from({ length: 50 }, (_, i) => message({ id: `m-${i}`, kind: 'user_input', createdAt: '2026-09-27T01:00:00.000Z' })));
  const next = [...older, ...rows];
  const anchor = conversationWindowAnchor(rows, next, 220);
  assert.equal(anchor, 270);
  const before = windowConversationRows(rows, 220);
  const after = windowConversationRows(next, anchor);
  assert.deepEqual(after.rows, before.rows);
  assert.equal(conversationWindowAnchor(rows, [], 220), 0);
});

test('用户气泡带上从工具调用推导的处置标记，模型自填的处置不生效', () => {
  const stored = normalizeBotMessage({
    id: 'turn-1',
    role: 'assistant',
    kind: 'agent_turn',
    createdAt: '2026-09-27T04:01:00.000Z',
    rounds: [{
      text: '',
      toolCalls: [
        { name: 'message_session', input: { intent: 'amend', sessionId: 's-merge', disposition: 'stopped' }, result: { ok: true, sessionId: 's-merge' } },
        { name: 'cancel_session', input: { sessionId: 's-stop', reason: '停下' }, result: { sessionId: 's-stop', status: 'cancelled' } },
        { name: 'spawn_session', input: { supersedes: 's-old' }, result: { sessionId: 's-new', status: 'running' } },
        { name: 'spawn_session', input: {}, result: { sessionId: 's-now', status: 'running' } },
        { name: 'spawn_session', input: { dependsOn: ['s-now'] }, result: { sessionId: 's-wait', status: 'queued' } },
        { name: 'post_reply', input: { text: '好', replyTo: ['u1'], sources: ['s-merge'], disposition: 'queued' }, result: { ok: true } },
      ],
    }],
  });
  assert.equal(stored?.rounds[0]?.toolCalls.length, 6);
  const rows = conversationRows([
    message({ id: 'u1', kind: 'user_input', createdAt: '2026-09-27T04:00:00.000Z', content: '插一句' }),
    stored!,
    message({
      id: 'reply-1',
      kind: 'agent_reply',
      createdAt: '2026-09-27T04:02:00.000Z',
      content: '好',
      replyTo: ['u1'],
      sources: ['s-merge'],
    }),
  ]);
  const shown = rows.filter((row) => row.type === 'message').map((row) => row.type === 'message' ? row.message : null);
  assert.deepEqual(shown.map((item) => item?.id), ['u1', 'reply-1']);
  assert.deepEqual(shown[0]?.dispositions.map((item) => [item.kind, item.sessionIds, item.labelKey]), [
    ['merged', ['s-merge'], 'projectAgent.chat.disposition.merged'],
    ['stopped', ['s-stop'], 'projectAgent.chat.disposition.stopped'],
    ['superseded', ['s-new'], 'projectAgent.chat.disposition.superseded'],
    ['parallel', ['s-now'], 'projectAgent.chat.disposition.parallel'],
    ['queued', ['s-wait'], 'projectAgent.chat.disposition.queued'],
    ['answered', ['s-merge'], 'projectAgent.chat.disposition.answered'],
  ]);
});

test('引用回复时，范围外的停止显示为没有影响其他任务', () => {
  const rows = conversationRows([
    message({ id: 'u0', kind: 'user_input', createdAt: '2026-09-27T05:00:00.000Z', content: '做登录' }),
    message({
      id: 'turn-spawn',
      kind: 'agent_turn',
      createdAt: '2026-09-27T05:00:30.000Z',
      rounds: [{
        text: '',
        toolCalls: [
          { name: 'spawn_session', input: { title: '登录' }, result: { sessionId: 's-login', status: 'running' } },
        ],
      }],
    }),
    message({
      id: 'r1',
      kind: 'agent_reply',
      createdAt: '2026-09-27T05:01:00.000Z',
      content: '登录任务在跑',
      replyTo: ['u0'],
      sources: ['s-login'],
    }),
    message({
      id: 'u1',
      kind: 'user_input',
      createdAt: '2026-09-27T05:02:00.000Z',
      content: '把这个停掉',
      quoteRefs: ['r1', '登录任务在跑'],
    }),
    message({
      id: 'turn-quote',
      kind: 'agent_turn',
      createdAt: '2026-09-27T05:03:00.000Z',
      rounds: [{
        text: '',
        toolCalls: [
          { name: 'cancel_session', input: { sessionId: 's-other', reason: '停' }, result: { sessionId: 's-other', status: 'cancelled' } },
          { name: 'message_session', input: { intent: 'amend', sessionId: 's-login' }, result: { ok: true, sessionId: 's-login' } },
        ],
      }],
    }),
  ]);
  const user = rows.find((row) => row.type === 'message' && row.message.id === 'u1');
  assert.equal(user?.type, 'message');
  if (user?.type !== 'message') return;
  assert.deepEqual(user.message.dispositions.map((item) => [item.kind, item.sessionIds[0]]), [
    ['out_of_scope', 's-other'],
    ['merged', 's-login'],
  ]);
  const outside = user.message.dispositions[0];
  assert.equal(outside?.title, '登录');
  assert.equal(
    createI18n('zh-CN').t(outside!.labelKey, { title: outside?.title }),
    '这句话针对的是『登录』，没有影响其他任务',
  );
});

test('引用和思考状态', () => {
  assert.deepEqual(quoteRefsFor(' reply-1 ', '  那一句  '), ['reply-1', '那一句']);
  assert.deepEqual(quoteRefsFor('', '文字'), []);
  assert.equal(showAgentThinking([], true), true);
  assert.equal(showAgentThinking([{ inputId: 'a', text: 'x', quoteRefs: [], createdAt: '', state: 'sending' }], true), false);
  assert.equal(showAgentThinking([], false), false);
});

test('optimistic, failed and acknowledged messages keep uploads until the durable echo', () => {
  const attachments = [{ id: 'file', name: 'brief.md', mimeType: 'text/markdown', size: 3,
    kind: 'text' as const, sourceKind: 'user_upload' as const, text: '正文' }];
  const input = { inputId: 'with-file', text: '', attachments, quoteRefs: [], createdAt: 'now', state: 'failed' as const };
  const pending = applyOptimistic([], [input])[0]!;
  assert.equal(pending.attachments?.[0]?.name, 'brief.md');
  assert.equal(pending.pending, 'failed');
  const acknowledged = applyOptimistic([], acknowledgeInput([input], input.inputId))[0]!;
  assert.deepEqual(acknowledged.attachments, attachments);
  const echo = normalizeBotMessage({ id: pending.id, kind: 'user_input', role: 'user', inputId: input.inputId,
    content: '', attachments })!;
  assert.equal(applyOptimistic([echo], [input]).length, 1);
  assert.equal(echo.attachments?.[0]?.name, 'brief.md');
});
