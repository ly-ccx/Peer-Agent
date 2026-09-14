import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLatestValueThrottle } from './latestValueThrottle.ts';

/** 可手动推进的时钟与定时器，保证用例确定、不依赖真实时间。 */
function harness(intervalMs = 200) {
  let clock = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, { callback: () => void; dueAt: number }>();
  const commits: Array<[string, string]> = [];

  const throttle = createLatestValueThrottle<string, string>({
    intervalMs,
    commit: (key, value) => commits.push([key, value]),
    now: () => clock,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle++;
      timers.set(handle, { callback, dueAt: clock + delayMs });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  return {
    throttle,
    commits,
    advance(ms: number) {
      clock += ms;
      for (const [handle, timer] of [...timers.entries()]) {
        if (timer.dueAt <= clock) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    pendingTimers: () => timers.size,
  };
}

describe('latest-value throttle', () => {
  it('commits the first value immediately so nothing is delayed', () => {
    const h = harness();
    h.throttle.push('c1', 'first');
    assert.deepEqual(h.commits, [['c1', 'first']]);
  });

  it('collapses a burst to the latest value and still delivers it', () => {
    const h = harness();
    h.throttle.push('c1', 'v0'); // 立即提交
    // 一次输出风暴：中间值全部丢弃，只保留最后一个。
    for (let i = 1; i <= 200; i += 1) h.throttle.push('c1', `v${i}`);
    assert.deepEqual(h.commits, [['c1', 'v0']], 'burst must not commit per event');

    h.advance(200);
    assert.deepEqual(h.commits, [
      ['c1', 'v0'],
      ['c1', 'v200'],
    ], 'the last value must land (no data loss)');
  });

  it('bounds writes to roughly one per interval under sustained load', () => {
    const h = harness(200);
    // 模拟 1000ms 内 500 个事件（约 500/s）。
    for (let elapsed = 0; elapsed < 1_000; elapsed += 2) {
      h.throttle.push('c1', `v${elapsed}`);
      h.advance(2);
    }
    h.throttle.flush();
    // 上界：1000ms / 200ms ≈ 5 次提交（加一次 flush），远低于 500 次事件。
    assert.ok(
      h.commits.length <= 8,
      `expected few commits under load, got ${h.commits.length} for 500 events`,
    );
    // 且必须是最后一个值，而不是被丢在中间。
    assert.equal(h.commits[h.commits.length - 1][1], 'v998');
  });

  it('keeps different conversations independent (no cross-key clobbering)', () => {
    const h = harness();
    h.throttle.push('c1', 'a0'); // 首个值立即提交
    h.throttle.push('c2', 'b0');
    h.throttle.push('c1', 'a1');
    h.throttle.push('c2', 'b1');
    h.advance(200);

    // 只断言「每个 key 的最后一个值都落库」这个语义性质，
    // 不断言提交顺序（那取决于 Map 的插入顺序，不是契约）。
    const latestByKey = new Map<string, string>();
    for (const [key, value] of h.commits) latestByKey.set(key, value);
    assert.equal(latestByKey.get('c1'), 'a1', 'c1 的最后一个值必须落库');
    assert.equal(latestByKey.get('c2'), 'b1', 'c2 的最后一个值必须落库');
    assert.ok(
      h.commits.length <= 4,
      `expected at most one commit per key per window, got ${h.commits.length}`,
    );
  });

  it('flush delivers pending values immediately (stream end / unmount)', () => {
    const h = harness();
    h.throttle.push('c1', 'v0');
    h.throttle.push('c1', 'pending');
    assert.equal(h.commits.length, 1);

    h.throttle.flush();
    assert.deepEqual(h.commits[1], ['c1', 'pending']);
    assert.equal(h.pendingTimers(), 0, 'flush must clear the trailing timer');
  });

  it('does not re-commit an already delivered value on flush', () => {
    const h = harness();
    h.throttle.push('c1', 'v0');
    h.throttle.flush();
    assert.deepEqual(h.commits, [['c1', 'v0']]);
  });

  it('cancel drops pending work without committing (conversation switch)', () => {
    const h = harness();
    h.throttle.push('c1', 'v0');
    h.throttle.push('c1', 'discarded');
    h.throttle.cancel();
    h.advance(1_000);
    assert.deepEqual(h.commits, [['c1', 'v0']], 'cancel must not commit pending values');
    assert.equal(h.pendingTimers(), 0);
  });
});
