import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamingScrollScheduler } from './streamingScrollScheduler.ts';

/** 可手动推进的假帧调度器：只有显式 flushFrame 时 rAF 回调才执行。 */
function harness() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  const log: string[] = [];
  const scheduler = createStreamingScrollScheduler({
    scheduler: {
      request(callback) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id) {
        callbacks.delete(id);
      },
    },
    follow: () => log.push('follow'),
    refresh: () => log.push('refresh'),
  });
  return {
    scheduler,
    log,
    pendingCount: () => callbacks.size,
    /** 模拟「进入下一帧」：执行该帧的 rAF 回调（含帧重置）。 */
    flushFrame() {
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback();
    },
  };
}

describe('streaming scroll scheduler', () => {
  it('commits the first follow synchronously (leading edge, no visible slip)', () => {
    const { scheduler, log } = harness();

    // 关键契约：首次请求必须立刻同步提交。
    // 调用方是 useLayoutEffect，同步提交意味着「先滚再画」，不会出现
    // 「内容先露出、下一帧才滚」的跳动。若改成推迟到 rAF，一旦 store 写入发生在
    // 浏览器该帧 rAF 阶段之后，回调就会落到下一帧而产生可见跳动。
    scheduler.scheduleFollow();
    assert.deepEqual(log, ['follow'], 'first follow must commit before returning');
  });

  it('drops further follow requests within the same frame', () => {
    const { scheduler, log, flushFrame } = harness();

    scheduler.scheduleFollow(); // 前沿提交
    for (let i = 0; i < 29; i += 1) scheduler.scheduleFollow(); // 同帧余量
    assert.deepEqual(log, ['follow'], 'a 30-request burst must commit only once');

    flushFrame(); // 进入下一帧
    scheduler.scheduleFollow();
    assert.deepEqual(log, ['follow', 'follow'], 'the next frame may commit again');
  });

  it('keeps one commit per frame across consecutive frames', () => {
    const { scheduler, log, flushFrame } = harness();
    for (let frame = 0; frame < 5; frame += 1) {
      for (let i = 0; i < 20; i += 1) scheduler.scheduleFollow();
      flushFrame();
    }
    // 100 次请求 → 每帧一次 = 5 次，而不是 100 次。
    assert.equal(log.length, 5, `expected 5 commits for 100 requests, got ${log.length}`);
  });

  it('does not let a follow and a refresh starve each other in the same frame', () => {
    const { scheduler, log } = harness();

    scheduler.scheduleFollow();
    scheduler.scheduleRefresh();
    scheduler.scheduleFollow();
    scheduler.scheduleRefresh();

    assert.equal(log.filter((entry) => entry === 'follow').length, 1);
    assert.equal(log.filter((entry) => entry === 'refresh').length, 1);
    assert.equal(log.length, 2, `both intents must survive one frame, got ${JSON.stringify(log)}`);
  });

  it('commits the first refresh synchronously too (bottom state stays accurate)', () => {
    const { scheduler, log } = harness();
    scheduler.scheduleRefresh();
    assert.deepEqual(log, ['refresh']);
  });

  it('stops committing after cancel (unmount / conversation switch)', () => {
    const { scheduler, log, flushFrame, pendingCount } = harness();
    scheduler.cancel();
    assert.equal(pendingCount(), 0);

    scheduler.scheduleFollow();
    scheduler.scheduleRefresh();
    flushFrame();
    assert.deepEqual(log, [], 'cancelled scheduler must not commit');
  });
});
