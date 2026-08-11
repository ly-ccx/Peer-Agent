import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMessageTargetWithRetry } from './messageNavigation.ts';

function createFrameQueue(): {
  readonly scheduleFrame: (callback: () => void) => void;
  readonly flushNext: () => void;
  readonly size: () => number;
} {
  const callbacks: Array<() => void> = [];
  return {
    scheduleFrame: (callback) => callbacks.push(callback),
    flushNext: () => callbacks.shift()?.(),
    size: () => callbacks.length,
  };
}

describe('message navigation target retry', () => {
  it('waits until a virtualized target mounts', async () => {
    const frames = createFrameQueue();
    const target = { id: 'message-8' };
    let attempts = 0;

    const result = findMessageTargetWithRetry({
      findTarget: () => (++attempts >= 3 ? target : null),
      scheduleFrame: frames.scheduleFrame,
      isActive: () => true,
      maxAttempts: 5,
    });

    assert.equal(frames.size(), 1);
    frames.flushNext();
    assert.equal(frames.size(), 1);
    frames.flushNext();
    assert.equal(await result, target);
    assert.equal(attempts, 3);
  });

  it('stops when a newer navigation request supersedes the wait', async () => {
    const frames = createFrameQueue();
    let active = true;
    let attempts = 0;

    const result = findMessageTargetWithRetry({
      findTarget: () => {
        attempts += 1;
        return null;
      },
      scheduleFrame: frames.scheduleFrame,
      isActive: () => active,
      maxAttempts: 5,
    });

    active = false;
    frames.flushNext();
    assert.equal(await result, null);
    assert.equal(attempts, 1);
  });

  it('uses a bounded number of attempts when the target never mounts', async () => {
    const frames = createFrameQueue();
    let attempts = 0;

    const result = findMessageTargetWithRetry({
      findTarget: () => {
        attempts += 1;
        return null;
      },
      scheduleFrame: frames.scheduleFrame,
      isActive: () => true,
      maxAttempts: 3,
    });

    frames.flushNext();
    frames.flushNext();
    assert.equal(await result, null);
    assert.equal(attempts, 3);
    assert.equal(frames.size(), 0);
  });
});
