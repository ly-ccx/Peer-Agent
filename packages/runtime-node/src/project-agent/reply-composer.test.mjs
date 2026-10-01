import assert from 'node:assert/strict';
import test from 'node:test';
import { decideSurfacing } from '@peer-agent/protocol';
import { planDelivery } from './digest.mjs';
import { projectCards } from './card-projection.mjs';
import { composeReply } from './reply-composer.mjs';

const USERS = [
  { id: 'input-a', kind: 'user_input' },
  { id: 'input-b', kind: 'user_input' },
];

function reply(extra = {}) {
  return composeReply({
    messageId: 'reply-1',
    kind: 'user',
    text: '好',
    replyTo: ['input-a'],
    userMessages: USERS,
    projectSessionIds: ['sess-1', 'sess-2'],
    ...extra,
  });
}

test('核验通过但任务仍阻塞时不能声明已签收', () => {
  const result = reply({ sources: ['sess-1'],
    statusClaims: [{ sessionId: 'sess-1', status: 'accepted' }],
    sessionStates: [{ sessionId: 'sess-1', status: 'waiting_user' }],
    verdicts: [{ sessionId: 'sess-1', outcome: 'passed' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'status_claim_mismatch');
});

test('状态声明必须覆盖来源，待确认不能声明已签收，真实签收可汇报', () => {
  for (const status of ['waiting_user', 'result_ready', 'accepted']) {
    const facts = { sources: ['sess-1'], sessionStates: [{sessionId:'sess-1',status}] };
    const matched = reply({...facts,statusClaims:[{sessionId:'sess-1',status}]});
    assert.equal(matched.ok,true);assert.deepEqual(matched.meta.sessionStates,facts.sessionStates);
    if (status !== 'accepted') assert.equal(reply({...facts,statusClaims:[{sessionId:'sess-1',status:'accepted'}]}).error,'status_claim_mismatch');
    for (const claims of [undefined,[],[{sessionId:'sess-2',status}], [{sessionId:'sess-1',status},{sessionId:'sess-1',status}]]) {
      assert.equal(reply({...facts,statusClaims:claims}).error,'status_claim_required');
    }
  }
});

test('未知锚点和非用户消息都不能作为 replyTo', () => {
  const missing = reply({ replyTo: ['missing', 'input-a'] });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'anchor_not_found');
  assert.deepEqual(missing.messageIds, ['missing']);

  const assistant = reply({
    replyTo: ['reply-old'],
    userMessages: [{ id: 'reply-old', kind: 'agent_reply', role: 'assistant' }],
  });
  assert.equal(assistant.ok, false);
  assert.equal(assistant.error, 'anchor_not_user_input');
  assert.deepEqual(assistant.messageIds, ['reply-old']);
});

test('唤醒回合没有 replyTo 且不是主动开口时拒绝，不自动挂单一锚点', () => {
  const rejected = reply({
    kind: 'wake',
    replyTo: [],
    anchorMessageId: 'input-a',
    userMessages: USERS,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'reply_to_required');

  const proactive = reply({
    kind: 'wake',
    proactive: true,
    replyTo: [],
    text: '有个想法',
    surfacing: {
      event: { origin: 'agent_idea', kind: 'idea', novelty: false, severity: 'info' },
      proactivity: 'normal',
    },
  });
  assert.equal(proactive.ok, true);
  assert.deepEqual(proactive.meta.replyTo, []);
  assert.equal(proactive.meta.surfacing, 'silent');
  assert.equal(proactive.message.proactive, true);
});

test('用户回合兜底挂到本回合全部输入，显式 post_reply 只保留给出的锚点', () => {
  const fallback = reply({
    fallback: true,
    replyTo: ['input-b'],
    turnInputIds: ['input-a', 'input-a', 'input-b'],
    text: '两件都接住了',
  });
  assert.equal(fallback.ok, true);
  assert.equal(fallback.message.fallback, true);
  assert.deepEqual(fallback.meta.replyTo, ['input-a', 'input-b']);

  const explicit = reply({
    replyTo: ['input-b'],
    turnInputIds: ['input-a', 'input-b'],
    text: '先答这一条',
  });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.message.fallback, false);
  assert.deepEqual(explicit.meta.replyTo, ['input-b']);
});

test('伪造的 sources 整条拒绝，不剔除后留下合法来源', () => {
  const forged = reply({
    sources: ['sess-1', 'other-project', 'sess-1'],
    verdicts: [{ sessionId: 'sess-1', outcome: 'passed', verdictRef: 'v1' }],
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, 'forged_sources');
  assert.deepEqual(forged.sessionIds, ['other-project']);
  assert.equal(forged.meta, undefined);
  assert.equal(forged.marks, undefined);
});

test('标记和送达由宿主事实重算，模型自带的结论与卡片被忽略', () => {
  const surfacing = {
    event: { origin: 'agent_idea', kind: 'observation', novelty: true, severity: 'notable' },
    proactivity: 'normal',
    foreground: false,
    quietHours: true,
    needsYou: true,
  };
  const input = {
    messageId: 'reply-1',
    kind: 'user',
    text: '两件都看过了',
    replyTo: ['input-a'],
    sources: ['sess-1', 'sess-2', 'sess-1'],
    statusClaims: [{sessionId:'sess-1',status:'failed'},{sessionId:'sess-2',status:'waiting_user'}],
    sessionStates: [{sessionId:'sess-1',status:'failed'},{sessionId:'sess-2',status:'waiting_user'}],
    userMessages: USERS,
    projectSessionIds: ['sess-1', 'sess-2'],
    verdicts: [
      { sessionId: 'sess-1', outcome: 'failed', verdictRef: 'v1', computedAt: '2026-09-27T00:00:00.000Z' },
      { sessionId: 'sess-2', outcome: 'partial', verdictRef: 'v2', computedAt: '2026-09-27T01:00:00.000Z' },
      { sessionId: 'other', outcome: 'passed', verdictRef: 'v-other', computedAt: '2026-09-27T03:00:00.000Z' },
    ],
    memoryUsed: ['mem-used'],
    toolCalls: [{ name: 'memory_remember', result: { id: 'mem-new' } }],
    surfacing,
    verdictRef: 'v-fake',
    cards: [{ type: 'needs_user', sessionId: 'sess-1' }],
    marks: [{ sessionId: 'sess-1', outcome: 'passed', verdictRef: 'v-fake' }],
    verdictChips: [{ sessionId: 'sess-1' }],
    question: { options: ['继续', '停'], type: 'approval' },
  };
  const first = composeReply(input);
  const second = composeReply(input);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(first.meta.verdictRef, 'v2');
  assert.deepEqual(first.marks, [
    { sessionId: 'sess-1', outcome: 'failed', verdictRef: 'v1' },
    { sessionId: 'sess-2', outcome: 'partial', verdictRef: 'v2' },
  ]);
  assert.deepEqual(first.meta.memoryUsed, ['mem-used']);
  assert.deepEqual(first.meta.memoryLearned, ['mem-new']);
  assert.equal(first.meta.surfacing, planDelivery(surfacing).decision);
  assert.equal(first.message.cards, undefined);
  assert.deepEqual(first.message.question, { options: ['继续', '停'] });

  const spoken = { ...surfacing, needsYou: false, quietHours: false, proactivity: 'high' };
  const quiet = composeReply({ ...input, surfacing: spoken });
  assert.equal(quiet.meta.surfacing, decideSurfacing(spoken).decision);
  assert.equal(first.meta.surfacing, 'interrupt');
  assert.equal(quiet.meta.surfacing, 'interrupt');

  const cards = projectCards('ws-1', { replies: [first.message] });
  const again = projectCards('ws-1', { replies: [first.message] });
  assert.deepEqual(again, cards);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].cardId, 'card:question:reply:reply-1');
  assert.equal(cards[0].kind, 'question');
  assert.deepEqual(cards[0].actions.map((item) => item.payload), [
    { answerTo: 'card:question:reply:reply-1', text: '继续' },
    { answerTo: 'card:question:reply:reply-1', text: '停' },
  ]);
});

test('静音时需要你仍然马上送达', () => {
  const muted = reply({
    text: '需要你批准写文件',
    surfacing: {
      event: { origin: 'user_request', kind: 'needs_user', novelty: true, severity: 'info' },
      proactivity: 'off',
      foreground: false,
      quietHours: false,
      needsYou: true,
    },
  });
  assert.equal(muted.ok, true);
  assert.equal(muted.meta.surfacing, 'interrupt');
});

test('省略送达事实时按用户请求的结果计算', () => {
  const result = reply({ text: '收到' });
  assert.equal(result.ok, true);
  assert.equal(result.meta.surfacing, decideSurfacing({
    event: { origin: 'user_request', kind: 'result', novelty: true, severity: 'info' },
    proactivity: 'normal',
    foreground: true,
    quietHours: false,
    needsYou: false,
  }).decision);
  assert.equal(result.meta.verdictRef, undefined);
  assert.deepEqual(result.marks, []);
  assert.deepEqual(result.meta.memoryUsed, []);
  assert.deepEqual(result.meta.memoryLearned, []);
});

test('memory_remember 的嵌套结果也能抽出 id', () => {
  const nested = reply({
    text: '记下了',
    toolCalls: [{
      name: 'memory_remember',
      result: { outputPreview: { legacyResult: { output: JSON.stringify({ ok: true, id: 'mem-nested' }) } } },
    }],
  });
  assert.equal(nested.ok, true);
  assert.deepEqual(nested.meta.memoryLearned, ['mem-nested']);
  const refused = reply({
    text: '没记下',
    toolCalls: [{ name: 'memory_remember', result: { ok: false, error: 'anchor_required' } }],
  });
  assert.deepEqual(refused.meta.memoryLearned, []);
});

test('Curator 生效的记忆 id 并进新记住', () => {
  const result = reply({
    text: '记下了',
    memoryLearned: ['mem-host'],
    curatorLearned: ['mem-curated'],
    toolCalls: [{ name: 'memory_remember', result: { ok: true, id: 'mem-tool' } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.meta.memoryLearned, ['mem-host', 'mem-curated', 'mem-tool']);
});
