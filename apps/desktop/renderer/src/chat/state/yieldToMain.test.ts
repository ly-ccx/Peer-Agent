import assert from 'node:assert/strict';
import test from 'node:test';
import { mapInChunks } from './yieldToMain.ts';

test('mapInChunks yields between chunks and preserves order', async () => {
  const yields: number[] = [];
  const result = await mapInChunks(
    [1, 2, 3, 4, 5],
    (value) => value * 10,
    {
      chunkSize: 2,
      yieldFn: async () => {
        yields.push(yields.length + 1);
      },
    },
  );

  assert.deepEqual(result, [10, 20, 30, 40, 50]);
  // yields after 2 and 4, but not after the final item
  assert.deepEqual(yields, [1, 2]);
});

test('mapInChunks with chunkSize >= length does not yield', async () => {
  let yieldCount = 0;
  const result = await mapInChunks(
    ['a', 'b'],
    (value) => value.toUpperCase(),
    {
      chunkSize: 10,
      yieldFn: async () => {
        yieldCount += 1;
      },
    },
  );
  assert.deepEqual(result, ['A', 'B']);
  assert.equal(yieldCount, 0);
});
