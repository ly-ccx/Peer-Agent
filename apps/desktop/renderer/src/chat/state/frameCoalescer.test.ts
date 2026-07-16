import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameCoalescer } from './frameCoalescer.ts';

function harness() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const coalescer = createFrameCoalescer({
    request(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id) {
      callbacks.delete(id);
    },
  });
  return { coalescer, callbacks };
}

describe('frame coalescer', () => {
  it('queues one frame and flushes only the latest high-frequency event', () => {
    const { coalescer, callbacks } = harness();
    const flushed: number[] = [];

    coalescer.request(() => flushed.push(1));
    coalescer.request(() => flushed.push(2));
    coalescer.request(() => flushed.push(3));

    assert.equal(callbacks.size, 1);
    callbacks.values().next().value?.();
    assert.deepEqual(flushed, [3]);
  });

  it('cancels queued work during teardown', () => {
    const { coalescer, callbacks } = harness();
    coalescer.request(() => assert.fail('cancelled callback ran'));

    coalescer.cancel();

    assert.equal(callbacks.size, 0);
  });
});
