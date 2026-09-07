import test from 'node:test';
import assert from 'node:assert/strict';
import { projectInlineChildMarks, resolveInlineChildNavigation } from './selectionSideChat.ts';

// These test domain decisions only, not real DOM hover/focus or disk restoration.
for (const count of [1, 3]) {
  for (const action of ['hover', 'click', 'keyboard', 'restore'] as const) {
    test(`inline navigation domain: ${count} children x ${action}`, () => {
      const ids = Array.from({ length: count }, (_, i) => `child-${i}`);
      const result = resolveInlineChildNavigation(ids, action);
      assert.equal(result.kind, action === 'hover' ? 'none' : count === 1 ? 'open' : 'list');
      if (result.kind === 'open') assert.equal(result.childId, ids[0]);
      if (result.kind === 'list') assert.deepEqual(result.childIds, ids);
      assert.deepEqual(resolveInlineChildNavigation(ids, action, true), { kind: 'none' });
    });
  }
}

test('overlapping marks retain both child IDs, adjacent marks stay separate', () => {
  const base = { sourceMessageId: 'm', sourceRevision: 1, createdAt: '2026-09-06T10:00:00Z' };
  const result = projectInlineChildMarks({ id: 'm', revision: 1, text: 'abcdef' }, [
    { ...base, childId: 'a', start: 0, end: 4, exactText: 'abcd' },
    { ...base, childId: 'b', start: 2, end: 5, exactText: 'cde' },
    { ...base, childId: 'c', start: 5, end: 6, exactText: 'f' },
  ]);
  assert.deepEqual(result.marks, [
    { start: 0, end: 2, childIds: ['a'] }, { start: 2, end: 4, childIds: ['a', 'b'] },
    { start: 4, end: 5, childIds: ['b'] }, { start: 5, end: 6, childIds: ['c'] },
  ]);
});

test('changed source does not relocate a mark to similar text', () => {
  const relation = { childId: 'a', sourceMessageId: 'm', sourceRevision: 1,
    createdAt: '2026-09-06', start: 0, end: 3, exactText: 'old' };
  for (const message of [{ id: 'm', revision: 2, text: 'old' }, { id: 'm', revision: 1, text: 'new old' }]) {
    assert.deepEqual(projectInlineChildMarks(message, [relation]), { marks: [], unavailableChildIds: ['a'] });
  }
  assert.deepEqual(resolveInlineChildNavigation(['a', 'a'], 'click'), { kind: 'open', childId: 'a' });
});
