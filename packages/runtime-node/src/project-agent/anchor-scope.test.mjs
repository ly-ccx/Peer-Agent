import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveAnchorScope } from './anchor-scope.mjs';

test('直接引用只收集被引用回复的任务', () => {
  const scope = resolveAnchorScope({
    messages: [
      { id: 'u0', role: 'user', kind: 'user_input' },
      { id: 'r1', role: 'assistant', kind: 'agent_reply', sources: ['s-login'], replyTo: ['u0'] },
      { id: 'u1', role: 'user', kind: 'user_input', quoteRefs: ['r1', '登录任务在跑'] },
    ],
  });
  assert.deepEqual(scope, { scoped: true, sessionIds: ['s-login'] });
});

test('回复链把上游回复上的 sessionId 也算进范围', () => {
  const scope = resolveAnchorScope({
    messages: [
      { id: 'r1', role: 'assistant', kind: 'agent_reply', sessionId: 's-login' },
      { id: 'r2', role: 'assistant', kind: 'agent_reply', replyTo: ['r1'], sources: ['s-pay'] },
      { id: 'u3', role: 'user', kind: 'user_input', quoteRefs: ['r2', '后一句'] },
    ],
  });
  assert.equal(scope.scoped, true);
  assert.deepEqual(scope.sessionIds, ['s-pay', 's-login']);
});

test('没有引用时范围是整个项目，更早的引用不会留下来', () => {
  const open = resolveAnchorScope({
    messages: [
      { id: 'u1', role: 'user', kind: 'user_input', content: '看看全部' },
    ],
  });
  assert.deepEqual(open, { scoped: false, sessionIds: [] });

  const later = resolveAnchorScope({
    messages: [
      { id: 'r1', role: 'assistant', kind: 'agent_reply', sources: ['s-login'] },
      { id: 'u2', role: 'user', kind: 'user_input', quoteRefs: ['r1', '登录'] },
      { id: 'a1', role: 'assistant', kind: 'agent_reply', content: '好' },
      { id: 'u3', role: 'user', kind: 'user_input', content: '再看一下全部' },
    ],
  });
  assert.deepEqual(later, { scoped: false, sessionIds: [] });
  assert.deepEqual(resolveAnchorScope({}), { scoped: false, sessionIds: [] });
});

test('引用到了消息但任务还对不上时，范围是空的而不是整个项目', () => {
  const scope = resolveAnchorScope({
    messages: [
      { id: 'u1', role: 'user', kind: 'user_input', quoteRefs: ['missing-reply', '那一句'] },
    ],
  });
  assert.deepEqual(scope, { scoped: true, sessionIds: [] });
});

test('显式 quoteRefs 在没有触发句时同样能算出范围', () => {
  const scope = resolveAnchorScope({
    messages: [
      { id: 'r1', role: 'assistant', kind: 'agent_reply', meta: { sources: ['s-keep'] } },
    ],
    quoteRefs: ['r1', '摘录'],
  });
  assert.deepEqual(scope, { scoped: true, sessionIds: ['s-keep'] });
});
