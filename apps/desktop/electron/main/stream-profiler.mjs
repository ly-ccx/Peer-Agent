// 流式链路计时埋点（主进程侧）。
//
// 目的：在「输出过快就卡」这类症状里，光看代码无法判断到底哪一环在吃主线程。
// 这里提供一个可开关的计时器，把每个环节的累计耗时与调用次数按固定间隔汇总成
// 一行日志，用来回答「每秒花掉多少毫秒、花在哪」。
//
// 设计约束：
//   - 关闭时必须是零成本（默认关闭：未设置 PEER_STREAM_PROFILE 时直接短路）。
//   - 纯逻辑，时钟与输出都可注入，便于在没有 Electron 的 node --test 里断言。
//   - 只做观测，不改变任何流式行为与事件顺序。

const DISABLED = Object.freeze({
  enabled: false,
  measure(_name, fn) {
    return fn();
  },
  bump() {},
  setGauge() {},
  report() {},
  snapshot() {
    return { enabled: false, windowMs: 0, counters: {}, durations: {} };
  },
});

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled]  是否启用；false 时所有方法短路
 * @param {() => number} [options.now] 时钟（毫秒）
 * @param {(line: string) => void} [options.report] 汇总输出（默认 console.log）
 * @param {number} [options.intervalMs] 汇总间隔
 */
export function createStreamProfiler(options = {}) {
  const enabled = options.enabled === true;
  if (!enabled) return DISABLED;

  const now = options.now ?? (() => performance.now());
  const report = options.report ?? ((line) => console.log(line));
  const intervalMs = options.intervalMs ?? 2000;

  /** @type {Record<string, number>} */
  const counters = {};
  /** @type {Record<string, { totalMs: number; calls: number; maxMs: number }>} */
  const durations = {};
  /** @type {Record<string, number>} */
  const gauges = {};
  let windowStart = now();

  function bump(name, delta = 1) {
    counters[name] = (counters[name] ?? 0) + delta;
  }

  function setGauge(name, value) {
    gauges[name] = value;
  }

  function measure(name, fn) {
    const started = now();
    try {
      return fn();
    } finally {
      const spent = now() - started;
      const entry = (durations[name] ??= { totalMs: 0, calls: 0, maxMs: 0 });
      entry.totalMs += spent;
      entry.calls += 1;
      if (spent > entry.maxMs) entry.maxMs = spent;
      // 顺带按窗口汇总：避免调用方还要自己触发 report。
      if (now() - windowStart >= intervalMs) flushWindow();
    }
  }

  function flushWindow() {
    const elapsed = now() - windowStart;
    if (elapsed <= 0) return;
    const seconds = elapsed / 1000;
    const parts = [];
    for (const [name, value] of Object.entries(counters)) {
      parts.push(`${name}=${value}(${(value / seconds).toFixed(1)}/s)`);
    }
    for (const [name, entry] of Object.entries(durations)) {
      parts.push(
        `${name}=${entry.totalMs.toFixed(1)}ms(${((entry.totalMs / elapsed) * 100).toFixed(1)}% of wall, ` +
          `${(entry.totalMs / Math.max(1, entry.calls)).toFixed(3)}ms/call, max ${entry.maxMs.toFixed(2)}ms)`,
      );
    }
    for (const [name, value] of Object.entries(gauges)) {
      parts.push(`${name}=${value}`);
    }
    if (parts.length > 0) {
      report(`[stream-profile] ${seconds.toFixed(1)}s | ${parts.join(' | ')}`);
    }
    // 清零用「删除」而不是「置 0」：置 0 会让后续每个窗口都刷出
    // `main.delta=0(0.0/s)` 这类噪音，把真正有活动的指标淹掉。
    // 渲染层实现（streamProfiler.ts）也是重建空对象，这里与之保持一致。
    for (const name of Object.keys(counters)) delete counters[name];
    for (const name of Object.keys(durations)) delete durations[name];
    windowStart = now();
  }

  return {
    enabled: true,
    measure,
    bump,
    setGauge,
    report: flushWindow,
    snapshot() {
      return {
        enabled: true,
        windowMs: now() - windowStart,
        counters: { ...counters },
        durations: JSON.parse(JSON.stringify(durations)),
        // gauges 与 counters/durations 不同：它是瞬时量，跨窗口保留（不清零），
        // 所以 snapshot 里也必须带上，否则拿到快照也看不到当前缓冲/速率状态。
        gauges: { ...gauges },
      };
    },
  };
}

/** 从环境变量判定是否开启（主进程入口调用一次）。 */
export function isStreamProfilingEnabled(env = process.env) {
  const raw = env?.PEER_STREAM_PROFILE;
  return raw === '1' || raw === 'true' || raw === 'on';
}
