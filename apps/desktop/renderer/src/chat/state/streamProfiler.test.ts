import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  __testing,
  getStreamProfiler,
  installConsoleHelper,
  setStreamProfilingEnabled,
} from './streamProfiler.ts';

describe('renderer stream profiler', () => {
  it('is a zero-cost passthrough while disabled', () => {
    setStreamProfilingEnabled(false);
    const profiler = getStreamProfiler();
    assert.equal(profiler.enabled, false);

    let calls = 0;
    const result = profiler.measure('any', () => {
      calls += 1;
      return 42;
    });
    assert.equal(result, 42, 'measure must return the wrapped value');
    assert.equal(calls, 1);

    // 关闭时不得累积任何数据，也不能有任何输出副作用。
    profiler.bump('x');
    profiler.setGauge('y', 1);
    const snapshot = profiler.snapshot();
    assert.deepEqual(snapshot, {
      enabled: false,
      windowMs: 0,
      counters: {},
      durations: {},
      gauges: {},
    });
  });

  it('aggregates counters, durations and gauges per window', () => {
    let clock = 0;
    const lines: string[] = [];
    // createEnabledProfiler 用 performance.now()，这里用真实时钟但手动控制 report。
    const profiler = __testing.createEnabledProfiler(1_000_000, (line) => lines.push(line));
    assert.equal(profiler.enabled, true);

    profiler.bump('write.store', 3);
    profiler.bump('typewriter.flush', 1);
    profiler.setGauge('frame.lastGapMs', 120);
    const measured = profiler.measure('write.store.notify', () => 'ok');
    assert.equal(measured, 'ok');

    assert.deepEqual(profiler.snapshot().counters, { 'write.store': 3, 'typewriter.flush': 1 });
    profiler.report();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /write\.store=3/);
    assert.match(lines[0], /typewriter\.flush=1/);
    assert.match(lines[0], /write\.store\.notify=/);
    assert.match(lines[0], /frame\.lastGapMs=120/);

    // 汇总后窗口清零，避免日志里出现累计值。
    assert.deepEqual(profiler.snapshot().counters, {});
    void clock;
  });

  it('stays silent when a window records nothing', () => {
    const lines: string[] = [];
    const profiler = __testing.createEnabledProfiler(1_000_000, (line) => lines.push(line));
    profiler.report();
    assert.deepEqual(lines, [], 'empty window should not spam the log');
  });
});

describe('devtools console entry point', () => {
  it('exposes __peerStreamProfile when a window exists, and it round-trips', () => {
    const host = globalThis as unknown as { window?: Record<string, unknown> };
    const hadWindow = 'window' in host;
    const previous = host.window;
    host.window = {}; // 模拟浏览器环境（node --test 默认没有 window）

    try {
      installConsoleHelper();
      const helper = host.window.__peerStreamProfile as {
        enable: () => void;
        disable: () => void;
        report: () => void;
        snapshot: () => { enabled: boolean };
      };
      assert.ok(helper, '__peerStreamProfile must be installed for the DevTools console');

      helper.enable();
      assert.equal(getStreamProfiler().enabled, true, 'enable() must turn profiling on');
      assert.equal(helper.snapshot().enabled, true);

      helper.disable();
      assert.equal(getStreamProfiler().enabled, false, 'disable() must turn profiling back off');
      assert.equal(helper.snapshot().enabled, false);
    } finally {
      // 还原全局，避免影响其他用例。
      if (hadWindow) host.window = previous;
      else delete host.window;
    }
  });

  it('does not throw when there is no window (server-side / node)', () => {
    const host = globalThis as unknown as { window?: Record<string, unknown> };
    const hadWindow = 'window' in host;
    const previous = host.window;
    delete host.window;
    try {
      assert.doesNotThrow(() => installConsoleHelper());
    } finally {
      if (hadWindow) host.window = previous;
    }
  });
});
