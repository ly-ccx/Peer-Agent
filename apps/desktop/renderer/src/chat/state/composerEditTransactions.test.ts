import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposerEditTransactions } from './composerEditTransactions.ts';
const value = (text: string, start = text.length, end = start) => ({ text, start, end });

test('typing, one suggestion and later manual edits undo and redo in their original order', () => {
  const history = createComposerEditTransactions(() => 1);
  history.reset(value(''));
  history.record(value(''), value('请'), 'typing'); history.record(value('请'), value('请再'), 'typing');
  history.record(value('请再'), value('请再检查过渡。'), 'prediction');
  history.record(value('请再检查过渡。'), value('请再检查过渡。谢'), 'typing');
  history.record(value('请再检查过渡。谢'), value('请再检查过渡。谢谢'), 'typing');
  assert.deepEqual(history.undo('请再检查过渡。谢谢'), value('请再检查过渡。'));
  assert.deepEqual(history.undo('请再检查过渡。'), value('请再'));
  assert.deepEqual(history.undo('请再'), value(''));
  assert.deepEqual(history.redo(''), value('请再'));
  assert.deepEqual(history.redo('请再'), value('请再检查过渡。'));
});

test('selection and external replacement are preserved, new typing invalidates redo', () => {
  const history = createComposerEditTransactions();
  history.reset(value('abc', 1, 2)); history.record(value('abc', 1, 2), value('aXc', 2), 'edit');
  assert.deepEqual(history.undo('aXc'), value('abc', 1, 2));
  history.record(value('abc', 1, 2), value('aYc', 2), 'edit');
  assert.equal(history.redo('aYc'), null); assert.equal(history.undo('external draft'), null);
});
