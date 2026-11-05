import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createConversationStore } from './index.mjs';

function storeWith(t, count, contentFor = (index) => `message ${index}`) {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ storeDir: dir });
  const conversation = store.createConversation({ title: 'window' });
  for (let index = 0; index < count; index += 1) {
    store.appendMessage(conversation.id, {
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: contentFor(index),
    }, { returnMessages: false });
  }
  return { store, id: conversation.id };
}

test('default window is the tail and older pages walk upward without a full message array', (t) => {
  const { store, id } = storeWith(t, 25);
  const first = store.readConversationWindow(id, { limit: 10, chunkBytes: 8 });
  assert.equal(Object.hasOwn(first, 'messages'), false);
  assert.deepEqual(first.window.map((row) => row.id), Array.from({ length: 10 }, (_, index) => `m-${15 + index}`));
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.cursor, 'string');
  assert.equal(first.meta.id, id);
  assert.equal(first.meta.messageCount, 25);

  const second = store.readConversationWindow(id, { limit: 10, before: first.cursor, chunkBytes: 8 });
  assert.deepEqual(second.window.map((row) => row.id), Array.from({ length: 10 }, (_, index) => `m-${5 + index}`));
  assert.equal(second.hasMore, true);
  assert.notEqual(second.cursor, first.cursor);

  const third = store.readConversationWindow(id, { limit: 10, before: second.cursor, chunkBytes: 8 });
  assert.deepEqual(third.window.map((row) => row.id), ['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
  assert.equal(third.hasMore, false);
  assert.equal(third.cursor, null);

  const paged = [...third.window, ...second.window, ...first.window].map((row) => row.id);
  assert.deepEqual(paged, Array.from({ length: 25 }, (_, index) => `m-${index}`));
});

test('multibyte lines split across byte chunks stay intact', (t) => {
  const { store, id } = storeWith(t, 6, () => `汉字${'测'.repeat(20)}`);
  const page = store.readConversationWindow(id, { limit: 4, chunkBytes: 3 });
  assert.equal(page.window.length, 4);
  assert.equal(page.window[0].id, 'm-2');
  assert.equal(page.window.at(-1).id, 'm-5');
  assert.match(page.window[0].content, /^汉字测/);
  const older = store.readConversationWindow(id, { limit: 4, before: page.cursor, chunkBytes: 3 });
  assert.deepEqual(older.window.map((row) => row.id), ['m-0', 'm-1']);
  assert.equal(older.hasMore, false);
});

test('full:true is the only path that returns every message', (t) => {
  const { store, id } = storeWith(t, 5);
  const windowed = store.readConversationWindow(id, { limit: 2 });
  assert.deepEqual(windowed.window.map((row) => row.id), ['m-3', 'm-4']);
  const full = store.readConversationWindow(id, { full: true, limit: 2 });
  assert.deepEqual(full.window.map((row) => row.id), ['m-0', 'm-1', 'm-2', 'm-3', 'm-4']);
  assert.equal(full.hasMore, false);
  assert.equal(full.cursor, null);
});

test('background read yields while parsing and matches the full conversation', async (t) => {
  const { store, id } = storeWith(t, 12);
  let yields = 0;
  const loaded = await store.readConversationYielding(id, {
    yieldEvery: 4,
    yield: async () => { yields += 1; },
  });
  assert.ok(yields > 0);
  assert.deepEqual(
    loaded.messages.map((row) => row.id),
    store.getConversation(id).messages.map((row) => row.id),
  );
});
