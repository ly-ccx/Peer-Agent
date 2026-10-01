import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationPager } from './conversationPager.ts';

test('10000-message conversation opens its tail, prepends older pages and keeps new replies', async () => {
  const history = Array.from({ length: 10000 }, (_, n) => ({ id: `m-${n}`, role: 'user', content: String(n), createdAt: new Date(n * 1000).toISOString() }));
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
