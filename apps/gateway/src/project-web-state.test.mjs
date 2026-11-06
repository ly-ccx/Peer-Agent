import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRemoteHistory } from './project-web-state.mjs';
const rows = (start, end) => Array.from({ length: end - start }, (_, n) => ({ id: String(start + n), content: String(start + n) }));

test('remote history retains pages, deduplicates overlap and exposes unbridged ranges', () => {
  const state = createRemoteHistory();
  state.accept({ messages: rows(100, 105), nextCursor: '100' });
  let value = state.accept({ messages: rows(110, 115), nextCursor: '110' });
  assert.equal(value.gapBefore, '110');
  assert.throws(() => state.accept({ messages: rows(120, 125), nextCursor: '120' }), /HISTORY_GAP_PENDING/);
  value = state.accept({ messages: rows(105, 110), nextCursor: '105' }, true);
  assert.equal(value.gapBefore, '105');
  value = state.accept({ messages: rows(100, 105), nextCursor: '100' }, true);
  assert.equal(value.gapBefore, null); assert.equal(value.nextCursor, '100');
  assert.deepEqual(value.messages.map(row => row.id), rows(100, 115).map(row => row.id));
  value = state.accept({ messages: rows(112, 117), nextCursor: '112' });
  assert.deepEqual(value.messages.map(row => row.id), rows(100, 117).map(row => row.id));
  assert.equal(value.nextCursor, '100');
});
test('stalled pages preserve the cursor and a new scope never receives old history', () => {
  const state = createRemoteHistory(); state.accept({ messages: rows(5, 10), nextCursor: '5' });
  assert.throws(() => state.accept({ messages: rows(0, 5), nextCursor: '5' }, true), /CURSOR_STALLED/);
  assert.deepEqual(state.snapshot().messages.map(row => row.id), rows(5, 10).map(row => row.id));
  assert.deepEqual(createRemoteHistory().snapshot().messages, []);
});
test('exhausting a disconnected range cannot silently turn an unproven join into continuous history', () => {
  const state = createRemoteHistory(); state.accept({ messages: rows(0, 5), nextCursor: null });
  state.accept({ messages: rows(20, 25), nextCursor: '20' });
  assert.throws(() => state.accept({ messages: rows(10, 20), nextCursor: null }, true), /HISTORY_GAP_UNRESOLVED/);
  assert.equal(state.snapshot().gapBefore, '20'); assert.equal(state.snapshot().nextCursor, '20');
});
