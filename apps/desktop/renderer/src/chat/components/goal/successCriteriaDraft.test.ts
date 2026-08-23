import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addManualCriterion,
  removeCriterion,
  replaceCriterionDescription,
  sanitizeSuccessCriteriaDraft,
  successCriteriaDraftEquals,
} from './successCriteriaDraft.ts';

test('draft helpers edit, add, drop empty rows, and compare', () => {
  const start = [{ id: 'c1', kind: 'manual' as const, description: '旧标准' }];
  const edited = replaceCriterionDescription(start, 'c1', '新标准');
  assert.equal(edited[0]?.description, '新标准');

  const withEmpty = addManualCriterion(edited);
  assert.equal(withEmpty.length, 2);
  assert.equal(withEmpty[1]?.kind, 'manual');
  assert.deepEqual(sanitizeSuccessCriteriaDraft(withEmpty), edited);

  const removed = removeCriterion(edited, 'c1');
  assert.deepEqual(removed, []);
  assert.equal(successCriteriaDraftEquals(edited, edited), true);
  assert.equal(successCriteriaDraftEquals(edited, start), false);
});
