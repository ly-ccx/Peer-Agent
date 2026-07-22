import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeConversationListPage,
  shouldShowConversationLoadMore,
} from './conversationListPagination.ts';

test('a short first page has no next page and does not show Load more', () => {
  const page = normalizeConversationListPage({
    items: [{ id: 'one' }, { id: 'two' }],
    nextCursor: null,
    hasMore: false,
  });

  assert.deepEqual(page, {
    items: [{ id: 'one' }, { id: 'two' }],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(shouldShowConversationLoadMore({
    conversationCount: page.items.length,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
  }), false);
});

test('replacing a paginated list with a legacy short list clears stale pagination', () => {
  const previousPage = normalizeConversationListPage({
    items: [{ id: 'old' }],
    nextCursor: 'old',
    hasMore: true,
  });
  assert.equal(previousPage.hasMore, true);

  const replacement = normalizeConversationListPage([{ id: 'one' }, { id: 'two' }]);
  assert.deepEqual(replacement, {
    items: [{ id: 'one' }, { id: 'two' }],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(shouldShowConversationLoadMore({
    conversationCount: replacement.items.length,
    hasMore: replacement.hasMore,
    nextCursor: replacement.nextCursor,
  }), false);
});

test('Load more is shown only when the server provides both hasMore and a cursor', () => {
  assert.equal(shouldShowConversationLoadMore({
    conversationCount: 2,
    hasMore: true,
    nextCursor: 'two',
  }), true);
  assert.equal(shouldShowConversationLoadMore({
    conversationCount: 2,
    hasMore: true,
    nextCursor: null,
  }), false);
});
