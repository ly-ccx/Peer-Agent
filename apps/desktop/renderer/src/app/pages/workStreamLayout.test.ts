import assert from 'node:assert/strict';
import test from 'node:test';
import {
  packWorkStreamColumns,
  resultCardWeight,
  shouldPackWorkStream,
  workStreamColumnCount,
  workStreamItemWeight,
} from './workStreamLayout.ts';

test('two columns only when the stream is wide enough for two 28rem tracks plus gap', () => {
  assert.equal(workStreamColumnCount(0), 1);
  assert.equal(workStreamColumnCount(56.74 * 16), 1);
  assert.equal(workStreamColumnCount(56.75 * 16), 2);
});

test('card weight follows real plan steps instead of a fake minimum height', () => {
  assert.equal(workStreamItemWeight({}), 4);
  assert.equal(workStreamItemWeight({ planSteps: [] }), 4);
  assert.equal(
    workStreamItemWeight({
      planSteps: [
        { taskId: 'a', title: 'one', status: 'completed' },
        { taskId: 'b', title: 'two', status: 'running', current: true },
      ],
    }),
    6,
  );
});

test('third card tucks beside a short neighbor instead of starting a new equal-height row', () => {
  const items = [
    { id: 'long', planSteps: [1, 2, 3, 4, 5] },
    { id: 'short', planSteps: [1] },
    { id: 'next', planSteps: [1] },
  ];
  const [left, right] = packWorkStreamColumns(items, 2, (item) =>
    workStreamItemWeight({ planSteps: item.planSteps.map((step) => ({ taskId: String(step), title: '', status: 'pending' })) }),
  );
  assert.deepEqual(left.map((item) => item.id), ['long']);
  assert.deepEqual(right.map((item) => item.id), ['short', 'next']);
});

test('a single column keeps source order and does not invent a second track', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const packed = packWorkStreamColumns(items, 1, () => 1);
  assert.equal(packed.length, 1);
  assert.deepEqual(packed[0].map((item) => item.id), ['a', 'b', 'c']);
});

test('waterfall packing starts at three cards on a two-column stream', () => {
  assert.equal(shouldPackWorkStream(2, 2), false);
  assert.equal(shouldPackWorkStream(3, 1), false);
  assert.equal(shouldPackWorkStream(3, 2), true);
});

test('result cards weigh the goal-thread tree, not leftover planSteps', () => {
  assert.equal(resultCardWeight(), 4);
  assert.equal(resultCardWeight(0), 4);
  assert.equal(resultCardWeight(3), 7);
});

test('a later short result card tucks beside a tall goal-thread neighbor', () => {
  const groups = [
    { id: 'thread', nodes: 3 },
    { id: 'short-a', nodes: 0 },
    { id: 'short-b', nodes: 0 },
  ];
  const [left, right] = packWorkStreamColumns(groups, 2, (group) => resultCardWeight(group.nodes));
  assert.deepEqual(left.map((group) => group.id), ['thread']);
  assert.deepEqual(right.map((group) => group.id), ['short-a', 'short-b']);
});
