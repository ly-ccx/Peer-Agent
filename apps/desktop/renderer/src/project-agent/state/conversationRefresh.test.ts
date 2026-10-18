import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationRefresh } from './conversationRefresh.ts';

test('notifications during the read coalesce into one subsequent read', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = createConversationRefresh(async () => { reads += 1; if (reads === 1) await gate; });
  const first = refresh.request();
  void refresh.request(); void refresh.request();
  assert.equal(reads, 1);
  release(); await first;
  assert.equal(reads, 2);
  await refresh.request();
  assert.equal(reads, 3);
});

test('cross-channel bursts share a bounded delay and stopping releases scheduled readers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const refresh = createConversationRefresh(async () => { reads++; }, { delayMs: 80 });
  const first = refresh.request();
  for (let i = 0; i < 100; i++) assert.equal(refresh.request(), first);
  assert.equal(reads, 0); t.mock.timers.tick(79); assert.equal(reads, 0);
  t.mock.timers.tick(1); await first; assert.equal(reads, 1);
  const stopped = refresh.request(); refresh.stop(); await stopped;
  t.mock.timers.tick(1000); assert.equal(reads, 1);
});

test('unmounted conversations drop pending refreshes', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = createConversationRefresh(async () => { reads += 1; await gate; });
  const first = refresh.request(); void refresh.request();
  refresh.stop(); release(); await first; await refresh.request();
  assert.equal(reads, 1);
});
