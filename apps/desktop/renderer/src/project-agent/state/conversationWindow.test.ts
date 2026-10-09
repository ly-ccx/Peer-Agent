import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationRowKey, conversationOffsets, conversationRowAt, conversationViewport, restoreConversationOffset } from './conversationWindow.ts';
import { normalizeBotMessage } from './botConversationState.ts';

test('the provisional input and durable receipt share one row identity', () => {
  const pending = normalizeBotMessage({ id: 'input-a', kind: 'user_input', inputId: 'a' })!;
  const receipt = { ...pending, id: 'host-record-a', pending: undefined };
  assert.equal(conversationRowKey({ type: 'message', message: pending }), conversationRowKey({ type: 'message', message: receipt }));
  assert.notEqual(conversationRowKey({ type: 'message', message: receipt }), conversationRowKey({ type: 'message', message: { ...receipt, inputId: 'b' } }));
});

test('variable heights cover the actual viewport with bounded overscan', () => {
  const keys = Array.from({ length: 1000 }, (_, i) => String(i));
  const heights = new Map(keys.map((key, i) => [key, i % 7 === 0 ? 1200 : 44]));
  const offsets = conversationOffsets(keys, heights);
  for (const index of [0, 55, 499, 998]) {
    const top = offsets[index]! + 10;
    const view = conversationViewport(offsets, top, 900);
    assert.ok(view.start <= index);
    assert.ok(view.end > conversationRowAt(offsets, top + 900));
    assert.ok(view.end - view.start <= 100);
    assert.equal(view.before + offsets[view.end]! - offsets[view.start]! + view.after, offsets.at(-1));
  }
});

test('prepending across 200 rows retains the same message and viewport offset', () => {
  const old = Array.from({ length: 163 }, (_, i) => `old-${i}`);
  const prefix = Array.from({ length: 50 }, (_, i) => `new-${i}`);
  const heights = new Map([...old, ...prefix].map((key, i) => [key, i % 2 ? 87 : 51]));
  const anchor = { key: old[0]!, delta: 35 };
  const before = restoreConversationOffset(old, conversationOffsets(old, heights), anchor, 52)!;
  const keys = [...prefix, ...old], offsets = conversationOffsets(keys, heights);
  const after = restoreConversationOffset(keys, offsets, anchor, 52)!;
  assert.equal(after - before, prefix.reduce((n, key) => n + heights.get(key)!, 0));
  assert.ok(conversationViewport(offsets, after - 52, 660).end > 50);
  assert.equal(restoreConversationOffset(keys, offsets, { key: 'missing', delta: 0 }), null);
});

test('newly measured heights before an anchor adjust position without changing its identity', () => {
  const keys = Array.from({ length: 300 }, (_, i) => String(i));
  const anchor = { key: '200', delta: 120 };
  const estimated = restoreConversationOffset(keys, conversationOffsets(keys, new Map()), anchor)!;
  const measured = restoreConversationOffset(keys, conversationOffsets(keys, new Map([['10', 800], ['150', 36]])), anchor)!;
  assert.equal(measured - estimated, 800 - 72 + 36 - 72);
});
