import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationPager } from './conversationPager.ts';

test('unchanged refresh retains historical message identity but publishes a changed source status', async () => {
  let raw = { id: 'reply', role: 'assistant', kind: 'agent_reply', content: 'actual reply', createdAt: '2026-01-01',
    sources: ['s'], meta: { sessionStates: [{ sessionId: 's', status: 'running' }] } };
  const snapshots: { messages: readonly import('./botConversationState').BotChatMessage[] }[] = [];
  const pager = createConversationPager({ read: async () => ({ ok: true, messages: [structuredClone(raw)] }), publish: value => snapshots.push(value) });
  await pager.refresh(); await pager.refresh();
  assert.equal(snapshots[0]!.messages, snapshots[1]!.messages);
  raw = { ...raw, meta: { sessionStates: [{ sessionId: 's', status: 'cancelled' }] } };
  await pager.refresh();
  assert.notEqual(snapshots[1]!.messages[0], snapshots[2]!.messages[0]);
});

test('latest host refresh retires a disappeared confirmation while preserving loaded history and real system messages', async () => {
  let shown = true;
  let snapshot: Parameters<Parameters<typeof createConversationPager>[0]['publish']>[0];
  const pager = createConversationPager({ read: async params => ({ ok: true, nextCursor: params.before ? null : 'new', messages: params.before
    ? [{ id: 'old', role: 'user', content: '历史', createdAt: '1' }]
    : [{ id: 'new', role: 'assistant', kind: 'system_card', content: '持久化记录', createdAt: '2' }, ...(shown ? [{
      id: 'card:confirm_result:s', role: 'assistant', kind: 'system_card', cards: [{ cardId: 'card:confirm_result:s', kind: 'confirm_result', content: '结果', actions: [] }],
    }] : [])] }), publish: value => { snapshot = value; } });
  await pager.refresh(); await pager.older(); assert.equal(snapshot!.messages.length, 3);
  shown = false; await pager.refresh();
  assert.deepEqual(snapshot!.messages.map(message => message.id), ['old', 'new']);
});

test('10000-message conversation opens its tail, prepends older pages and keeps new replies', async () => {
  const history = Array.from({ length: 10000 }, (_, n) => ({ id: `m-${n}`, role: 'user', content: String(n), createdAt: new Date(0).toISOString() }));
  const requests: unknown[] = [];
  let snapshot: Parameters<Parameters<typeof createConversationPager>[0]['publish']>[0];
  const pager = createConversationPager({
    read: async params => {
      requests.push(params);
      const end = params.before ? history.findIndex(message => message.id === params.before) : history.length;
      const start = Math.max(0, end - params.limit);
      return { ok: true, messages: history.slice(start, end), nextCursor: start > 0 ? history[start]!.id : null };
    },
    publish: value => { snapshot = value; },
  });
  await pager.refresh();
  assert.equal(requests.length, 1);
  assert.equal(snapshot!.messages[0]!.id, 'm-9950');
  assert.equal(snapshot!.messages.at(-1)!.id, 'm-9999');
  await pager.older();
  assert.equal(snapshot!.messages[0]!.id, 'm-9900');
  history.push({ id: 'new-reply', role: 'assistant', content: 'actual reply', createdAt: new Date(10000 * 1000).toISOString() });
  await pager.refresh();
  assert.equal(snapshot!.messages[0]!.id, 'm-9900');
  assert.equal(snapshot!.messages.at(-1)!.id, 'new-reply');
  await pager.locate('m-9850');
  assert.equal(snapshot!.messages[0]!.id, 'm-9850');
  assert.equal(new Set(snapshot!.messages.map(message => message.id)).size, snapshot!.messages.length);
});

test('failed older page preserves cursor for retry and stopping drops an in-flight page', async () => {
  let calls = 0, fail = true, publishCount = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const pager = createConversationPager({ read: async params => {
    calls += 1;
    if (params.before && fail) return { ok: false };
    if (calls === 3) await gate;
    return { ok: true, messages: [{ id: params.before ? 'old' : 'new', role: 'user' }], nextCursor: params.before ? null : 'new' };
  }, publish: () => { publishCount += 1; } });
  await pager.refresh();
  await assert.rejects(pager.older());
  fail = false;
  const pending = pager.older();
  await Promise.resolve();
  pager.stop(); release(); await pending;
  assert.equal(publishCount, 1);
  await pager.refresh();
  assert.equal(calls, 3);
});

test('a burst larger than one page bridges every new message and retries a failed bridge atomically', async () => {
  const history = Array.from({ length: 500 }, (_, n) => ({ id: `m-${n}`, role: 'user', content: String(n), createdAt: new Date(n * 1000).toISOString() }));
  let fail = false;
  let snapshot: Parameters<Parameters<typeof createConversationPager>[0]['publish']>[0];
  const pager = createConversationPager({ read: async params => {
    if (params.before && fail) { fail = false; return { ok: false }; }
    const end = params.before ? history.findIndex(m => m.id === params.before) : history.length;
    const start = Math.max(0, end - params.limit);
    const messages: Record<string, unknown>[] = history.slice(start, end);
    if (!params.before) messages.push({ id: 'projected-card', role: 'assistant', kind: 'system_card' });
    return { ok: true, messages, nextCursor: start > 0 ? history[start]!.id : null };
  }, publish: value => { snapshot = value; } });
  await pager.refresh();
  history.push(...Array.from({ length: 110 }, (_, i) => { const n = i + 500; return { id: `m-${n}`, role: 'user', content: String(n), createdAt: new Date(n * 1000).toISOString() }; }));
  fail = true;
  await assert.rejects(pager.refresh());
  assert.equal(snapshot!.messages.filter(m => m.id !== 'projected-card').at(-1)!.id, 'm-499', 'failed bridge must not publish a partial gap');
  await pager.refresh();
  assert.deepEqual(snapshot!.messages.map(m => m.id), [...history.slice(450).map(m => m.id), 'projected-card']);
  await pager.older();
  assert.deepEqual(snapshot!.messages.map(m => m.id), [...history.slice(400).map(m => m.id), 'projected-card']);
});

test('latest decision stamp closes old question controls already retained in an older page', async () => {
  let active: string | null = 'old';
  let snapshot: Parameters<Parameters<typeof createConversationPager>[0]['publish']>[0];
  const old = { id: 'old', kind: 'agent_reply', role: 'assistant', content: 'Old decision', createdAt: '1', cards: [
    { cardId: 'card:question:reply:old', kind: 'question', content: 'Old choice', actions: [{ id: 'answer' }] },
    { cardId: 'card:approval:permission', kind: 'approval', content: 'Real permission', actions: [{ id: 'allow' }] },
  ] };
  const pager = createConversationPager({ read: async params => ({ ok: true, activeReplyQuestionId: active,
    nextCursor: params.before ? null : 'tail', messages: params.before ? [old] : [{ id: 'tail', role: 'user', content: 'Tail', createdAt: '2' }] }), publish: value => { snapshot = value; } });
  await pager.refresh(); await pager.older();
  assert.equal(snapshot!.messages[0]!.cards[0]!.resolvedState, undefined);
  active = null; await pager.refresh();
  assert.equal(snapshot!.messages[0]!.cards[0]!.resolvedState, 'resolved');
  assert.equal(snapshot!.messages[0]!.cards[0]!.actions?.length, 0);
  assert.equal(snapshot!.messages[0]!.cards[1]!.actions?.length, 1, 'question retirement cannot resolve permissions');
});
