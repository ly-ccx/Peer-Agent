import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStreamProfiler, isStreamProfilingEnabled } from './stream-profiler.mjs';

describe('main-process stream profiler', () => {
  it('is a zero-cost passthrough when disabled', () => {
    const profiler = createStreamProfiler({ enabled: false });
    assert.equal(profiler.enabled, false);

    let calls = 0;
    const value = profiler.measure('x', () => {
      calls += 1;
      return 'kept';
    });
    assert.equal(value, 'kept', 'measure must return the wrapped value');
    assert.equal(calls, 1);

    // 关闭时不得累积数据，也不得有输出副作用。
    profiler.bump('y');
    profiler.setGauge('z', 1);
    profiler.report();
    assert.deepEqual(profiler.snapshot(), {
      enabled: false,
      windowMs: 0,
      counters: {},
      durations: {},
    });
  });

  it('summarizes counters, rates, durations and gauges in one line', () => {
    let clock = 1_000; // 真实时钟不会停在 0；用正数更贴近运行环境
    const lines = [];
    const profiler = createStreamProfiler({
      enabled: true,
      now: () => clock,
      report: (line) => lines.push(line),
      // 窗口设得远大于本用例的墙钟：不让自动汇总插手，断言才是确定的。
      intervalMs: 1_000_000,
    });

    // 每轮模拟一个 chunk：+10ms 墙钟，其中 accumulate 占 2ms、repetition 占 1ms。
    for (let i = 0; i < 10; i += 1) {
      profiler.bump('main.delta');
      profiler.measure('main.delta.accumulate', () => {
        clock += 2;
      });
      profiler.measure('main.delta.repetition', () => {
        clock += 1;
      });
      clock += 7;
    }
    profiler.setGauge('accTextChars', 12_345);
    assert.deepEqual(lines, [], 'must not emit before the window elapses');

    profiler.report();
    assert.equal(lines.length, 1, `expected exactly one line, got ${JSON.stringify(lines)}`);
    const line = lines[0];
    assert.match(line, /^\[stream-profile\] /);
    assert.match(line, /main\.delta=10\b/, 'counter must be reported');
    assert.match(line, /main\.delta=10\(\d+\.\d+\/s\)/, 'counters must be reported as a rate');
    assert.match(line, /main\.delta\.accumulate=/, 'durations must include the timed stage');
    assert.match(line, /ms\/call/, 'durations must include per-call cost');
    assert.match(line, /accTextChars=12345/, 'gauges must be reported');

    // 汇总后 counter/duration 清零，避免日志出现累计值导致频率误判；
    // gauge 是瞬时量，保留（否则下一次汇总就看不到当前状态）。
    const snapshot = profiler.snapshot();
    assert.deepEqual(snapshot.counters, {});
    assert.deepEqual(snapshot.durations, {});
    assert.deepEqual(snapshot.gauges, { accTextChars: 12_345 });
  });

  it('auto-flushes when the window elapses mid-stream', () => {
    let clock = 1_000;
    const lines = [];
    const profiler = createStreamProfiler({
      enabled: true,
      now: () => clock,
      report: (line) => lines.push(line),
      intervalMs: 50,
    });

    // 每个 chunk 推进 10ms：跑满 10 个必然跨越 50ms 窗口边界，无需手动 report。
    for (let i = 0; i < 10; i += 1) {
      profiler.bump('main.delta');
      profiler.measure('main.delta.accumulate', () => {
        clock += 10;
      });
    }
    assert.ok(
      lines.length >= 1,
      `expected an automatic flush during a long stream, got ${JSON.stringify(lines)}`,
    );
    assert.match(lines[0], /main\.delta=/);
    // 「按窗口重置」而不是「整轮累计」：一共 bump 了 10 次，首行必须明显小于 10。
    const firstCount = Number(/main\.delta=(\d+)/.exec(lines[0])[1]);
    assert.ok(
      firstCount < 10,
      `counters must reset per window, but the first line reported ${firstCount} of 10 total bumps`,
    );
  });

  it('reports the persist throttle ratio so a per-chunk write storm would be visible', () => {
    // persist 每 chunk 都会调用，但只有每 500ms 真正落盘；两者都要能被看见，
    // 否则无法区分「每 chunk 写盘」和「写盘已节流」。
    let clock = 5_000;
    const lines = [];
    const profiler = createStreamProfiler({
      enabled: true,
      now: () => clock,
      report: (line) => lines.push(line),
      intervalMs: 1_000_000,
    });
    for (let i = 0; i < 100; i += 1) {
      profiler.bump('main.persist.skipped');
      clock += 1;
    }
    profiler.bump('main.persist');
    profiler.report();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /main\.persist\.skipped=100/);
    assert.match(lines[0], /main\.persist=1/);
  });

  it('stays silent instead of dividing by zero on a zero-length window', () => {
    const lines = [];
    const profiler = createStreamProfiler({
      enabled: true,
      now: () => 42, // 时钟不推进 → elapsed 为 0
      report: (line) => lines.push(line),
      intervalMs: 1000,
    });
    profiler.bump('main.delta');
    profiler.report();
    assert.deepEqual(lines, [], 'zero-length window must not emit a meaningless line');
  });

  it('reads the env switch', () => {
    assert.equal(isStreamProfilingEnabled({ PEER_STREAM_PROFILE: '1' }), true);
    assert.equal(isStreamProfilingEnabled({ PEER_STREAM_PROFILE: 'true' }), true);
    assert.equal(isStreamProfilingEnabled({ PEER_STREAM_PROFILE: 'on' }), true);
    assert.equal(isStreamProfilingEnabled({}), false);
    assert.equal(isStreamProfilingEnabled({ PEER_STREAM_PROFILE: '0' }), false);
  });
});
