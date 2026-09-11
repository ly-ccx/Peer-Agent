/**
 * 流式链路计时埋点（渲染层侧）。
 *
 * 用途：在「输出过快就卡」这类症状里，先量出「每秒写几次状态、每次写让主线程忙多久」，
 * 再决定改哪一环；否则只能靠猜。
 *
 * 开关：默认关闭（关闭时所有方法短路，零成本）。可在运行中的 DevTools 控制台直接打开，
 * 不需要重新构建：
 *   __peerStreamProfile.enable()
 *   __peerStreamProfile.report()
 *
 * 关键指标：
 *   - write.store          会话状态写入次数/秒（流式期间应远低于刷新率）
 *   - draw.*               每次渲染提交后主线程被占用的时长（rAF 间隔），>50ms 即可感知卡顿
 *   - typewriter.forcedFlush  跨泵强制 flush 次数（会把积压一次性写出，绕过节流）
 *   - typewriter.emit      打字机真正写入的次数
 */

export interface StreamProfilerSnapshot {
  readonly enabled: boolean;
  readonly windowMs: number;
  readonly counters: Record<string, number>;
  readonly durations: Record<string, { totalMs: number; calls: number; maxMs: number }>;
  readonly gauges: Record<string, number>;
}

export interface StreamProfiler {
  readonly enabled: boolean;
  /** 包裹一段同步逻辑计时；关闭时零成本直接调用。 */
  measure<T>(name: string, fn: () => T): T;
  /** 计数一次事件。 */
  bump(name: string, delta?: number): void;
  /** 记录一个瞬时值（如队列长度、累积字符数）。 */
  setGauge(name: string, value: number): void;
  /** 立即汇总输出一行。 */
  report(): void;
  snapshot(): StreamProfilerSnapshot;
}

const DISABLED_PROFILER: StreamProfiler = {
  enabled: false,
  measure: (_name, fn) => fn(),
  bump: () => {},
  setGauge: () => {},
  report: () => {},
  snapshot: () => ({ enabled: false, windowMs: 0, counters: {}, durations: {}, gauges: {} }),
};

const STORAGE_KEY = 'peer:stream-profile';

interface MutableState {
  counters: Record<string, number>;
  durations: Record<string, { totalMs: number; calls: number; maxMs: number }>;
  gauges: Record<string, number>;
  windowStartMs: number;
}

function createEnabledProfiler(intervalMs = 2000, log: (line: string) => void = console.log): StreamProfiler {
  const state: MutableState = {
    counters: {},
    durations: {},
    gauges: {},
    windowStartMs: performance.now(),
  };

  const flush = (reason: string) => {
    const now = performance.now();
    const elapsed = now - state.windowStartMs;
    if (elapsed <= 0) return;
    const seconds = elapsed / 1000;
    const parts: string[] = [];
    for (const [name, value] of Object.entries(state.counters)) {
      parts.push(`${name}=${value}(${(value / seconds).toFixed(1)}/s)`);
    }
    for (const [name, entry] of Object.entries(state.durations)) {
      parts.push(
        `${name}=${entry.totalMs.toFixed(1)}ms(${((entry.totalMs / elapsed) * 100).toFixed(1)}% wall, ` +
          `${(entry.totalMs / Math.max(1, entry.calls)).toFixed(2)}ms/call, max ${entry.maxMs.toFixed(1)}ms)`,
      );
    }
    for (const [name, value] of Object.entries(state.gauges)) {
      parts.push(`${name}=${value}`);
    }
    if (parts.length > 0) {
      log(`[stream-profile:renderer] ${reason} ${seconds.toFixed(1)}s | ${parts.join(' | ')}`);
    }
    state.counters = {};
    state.durations = {};
    state.windowStartMs = now;
  };

  return {
    enabled: true,
    measure<T>(name: string, fn: () => T): T {
      const started = performance.now();
      try {
        return fn();
      } finally {
        const spent = performance.now() - started;
        const entry = (state.durations[name] ??= { totalMs: 0, calls: 0, maxMs: 0 });
        entry.totalMs += spent;
        entry.calls += 1;
        if (spent > entry.maxMs) entry.maxMs = spent;
        if (performance.now() - state.windowStartMs >= intervalMs) flush('auto');
      }
    },
    bump(name, delta = 1) {
      state.counters[name] = (state.counters[name] ?? 0) + delta;
      if (performance.now() - state.windowStartMs >= intervalMs) flush('auto');
    },
    setGauge(name, value) {
      state.gauges[name] = value;
    },
    report() {
      flush('manual');
    },
    snapshot() {
      return {
        enabled: true,
        windowMs: performance.now() - state.windowStartMs,
        counters: { ...state.counters },
        durations: JSON.parse(JSON.stringify(state.durations)),
        gauges: { ...state.gauges },
      };
    },
  };
}

function readEnabledFromStorage(): boolean {
  // 只在浏览器环境读 localStorage：Node 下（node --test）触碰它会触发
  // `--localstorage-file` 警告，而且那里的值对本埋点没有意义。
  if (typeof window === 'undefined') return false;
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeEnabledToStorage(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* 隐私模式下忽略：本次会话仍然生效 */
  }
}

/**
 * 帧间隔抖动计：直接量「用户看到的卡」。
 * 开启后连续采样 rAF 间隔，超过阈值的帧计入 frame.jank，并记录最长帧间隔。
 * 这比给组件加 Profiler 轻得多，且能覆盖整条渲染链路。
 */
let frameGapInstalled = false;
function installFrameGapMeter(jankThresholdMs = 50): void {
  if (frameGapInstalled) return;
  if (typeof requestAnimationFrame !== 'function') return;
  frameGapInstalled = true;
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const gap = now - last;
    last = now;
    if (active.enabled) {
      active.setGauge('frame.lastGapMs', Math.round(gap));
      if (gap > jankThresholdMs) active.bump('frame.jank');
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

let active: StreamProfiler = DISABLED_PROFILER;
if (readEnabledFromStorage()) {
  active = createEnabledProfiler();
  installFrameGapMeter();
}

/** 当前埋点实例；关闭时为共享的零成本空实现（引用稳定，可安全用于依赖数组）。 */
export function getStreamProfiler(): StreamProfiler {
  return active;
}

/** 运行中开启/关闭（DevTools 控制台可用）。 */
export function setStreamProfilingEnabled(enabled: boolean): StreamProfiler {
  writeEnabledToStorage(enabled);
  active = enabled ? createEnabledProfiler() : DISABLED_PROFILER;
  if (enabled) {
    installFrameGapMeter();
    installConsoleHelper();
  }
  return active;
}

/**
 * 安装 DevTools 控制台入口 `__peerStreamProfile`。
 *
 * 既在模块加载时安装一次（运行中的应用可随时开启），也在 enable() 时再装一次：
 * 这样入口的存在不依赖模块加载顺序，也便于测试在 stub 出来的 window 上验证。
 */
export function installConsoleHelper(): void {
  const host = globalThis as unknown as { window?: Record<string, unknown> };
  if (!host.window) return;
  host.window.__peerStreamProfile = {
    enable: () => {
      setStreamProfilingEnabled(true);
      console.info('[stream-profile] 已开启；日志每 2s 汇总一行，用完请 __peerStreamProfile.disable()');
    },
    disable: () => {
      const profiler = getStreamProfiler();
      if (profiler.enabled) profiler.report();
      setStreamProfilingEnabled(false);
    },
    report: () => getStreamProfiler().report(),
    snapshot: () => getStreamProfiler().snapshot(),
  };
}

installConsoleHelper();

/** 供测试使用：不依赖 localStorage/window 的构造入口。 */
export const __testing = { createEnabledProfiler, installConsoleHelper };
