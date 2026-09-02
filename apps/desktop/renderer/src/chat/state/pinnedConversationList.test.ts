import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePinnedSectionConversations, selectPinnedConversations } from './pinnedConversationList.ts';


test('selectPinnedConversations keeps only pinned chats and sorts by pin order', () => {
  const selected = selectPinnedConversations([
    { id: 'c', pinnedAt: '2026-08-31T01:00:00.000Z', pinnedOrder: 2, updatedAt: '3' },
    { id: 'plain', pinnedAt: null, pinnedOrder: null, updatedAt: '9' },
    { id: 'a', pinnedAt: '2026-08-31T00:00:00.000Z', pinnedOrder: 0, updatedAt: '1' },
    { id: 'b', pinnedAt: '2026-08-31T00:30:00.000Z', pinnedOrder: 1, updatedAt: '2' },
  ]);

  assert.deepEqual(selected.map((item) => item.id), ['a', 'b', 'c']);
});

test('selectPinnedConversations falls back to recency when pin order ties', () => {
  const selected = selectPinnedConversations([
    { id: 'older', pinnedAt: '2026-08-31T00:00:00.000Z', pinnedOrder: 0, updatedAt: '1' },
    { id: 'newer', pinnedAt: '2026-08-31T00:30:00.000Z', pinnedOrder: 0, updatedAt: '2' },
  ]);

  assert.deepEqual(selected.map((item) => item.id), ['newer', 'older']);
});

test('mergePinnedSectionConversations drops a cached pin when current list unpins it', () => {
  const merged = mergePinnedSectionConversations(
    [
      { id: 'keep', pinnedAt: '2026-08-31T00:00:00.000Z', pinnedOrder: 0, updatedAt: '1' },
      { id: 'gone', pinnedAt: '2026-08-31T00:30:00.000Z', pinnedOrder: 1, updatedAt: '2' },
    ],
    [
      { id: 'gone', pinnedAt: null, pinnedOrder: null, updatedAt: '3' },
    ],
  );

  assert.deepEqual(merged.map((item) => item.id), ['keep']);
});

test('mergePinnedSectionConversations keeps a cached pin that is not in the current list', () => {
  const merged = mergePinnedSectionConversations(
    [
      { id: 'other-workspace', pinnedAt: '2026-08-31T00:00:00.000Z', pinnedOrder: 0, updatedAt: '1' },
    ],
    [
      { id: 'local', pinnedAt: '2026-08-31T00:30:00.000Z', pinnedOrder: 1, updatedAt: '2' },
    ],
  );

  assert.deepEqual(merged.map((item) => item.id), ['other-workspace', 'local']);
});
