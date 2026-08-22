import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeConversationListPage,
  shouldContinueConversationList,
} from './conversationListPagination.ts';

test('a short first page has no next page and does not keep fetching', () => {
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
  assert.equal(shouldContinueConversationList({
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
  assert.equal(shouldContinueConversationList({
    conversationCount: replacement.items.length,
    hasMore: replacement.hasMore,
    nextCursor: replacement.nextCursor,
  }), false);
});

test('later pages continue only when the server provides both hasMore and a cursor', () => {
  assert.equal(shouldContinueConversationList({
    conversationCount: 2,
    hasMore: true,
    nextCursor: 'two',
  }), true);
  assert.equal(shouldContinueConversationList({
    conversationCount: 2,
    hasMore: true,
    nextCursor: null,
  }), false);
});
