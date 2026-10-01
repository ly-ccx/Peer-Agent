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

test('unmounted conversations drop pending refreshes', async () => {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = createConversationRefresh(async () => { reads += 1; await gate; });
  const first = refresh.request(); void refresh.request();
  refresh.stop(); release(); await first; await refresh.request();
  assert.equal(reads, 1);
});
