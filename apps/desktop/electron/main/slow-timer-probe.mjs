/**
 * rc.38 本机采样不能把未符号化的 JS/JIT 地址当成业务根因。
 * 主进程忙态落在 node::Environment::RunTimers 下的深层回调里，采样没有函数名。
 * 这里只给超过阈值的定时器回调记一行：耗时、函数名、源码首行（字符串字面量打码）。
 * 不记录回调参数，也不打印计划正文。
 *
 * 默认 100ms。PEER_AGENT_SLOW_TIMER_MS=0 关闭，设为正数则改阈值。
 * 只在 Electron 主进程加载时自动安装；单测显式调用 installSlowTimerProbe。
 */

const DEFAULT_THRESHOLD_MS = 100;
const RATE_LIMIT_MS = 10_000;
const MAX_LABEL = 180;

export function slowTimerThresholdMs(env = process.env) {
  const raw = env.PEER_AGENT_SLOW_TIMER_MS;
  if (raw === undefined || raw === '') return DEFAULT_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD_MS;
}

export function callbackLabel(fn) {
  const name = typeof fn?.name === 'string' && fn.name ? fn.name : 'anonymous';
  let source = '';
  try {
    source = Function.prototype.toString.call(fn).split('\n')[0] ?? '';
  } catch {
    source = '';
  }
  const redacted = source.replace(/['"`][^'"`\n]{0,4000}['"`]/g, '"…"');
  return `${name} ${redacted}`.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}

export function formatSlowTimer(elapsedMs, label) {
  return `[slow-timer] ms=${Math.round(elapsedMs)} callback=${label}`;
}

export function installSlowTimerProbe({
  thresholdMs = slowTimerThresholdMs(),
  log = (line) => console.info(line),
  timers = globalThis,
  now = () => performance.now(),
} = {}) {
  if (!(thresholdMs > 0) || timers.__peerSlowTimerInstalled) return () => {};
  const originalSetTimeout = timers.setTimeout?.bind(timers);
  const originalSetInterval = timers.setInterval?.bind(timers);
  if (typeof originalSetTimeout !== 'function' || typeof originalSetInterval !== 'function') return () => {};
  const lastLoggedAt = new Map();

  function note(started, fn) {
    const elapsed = now() - started;
    if (elapsed < thresholdMs) return;
    const label = callbackLabel(fn);
    const at = now();
    if (at - (lastLoggedAt.get(label) ?? -Infinity) < RATE_LIMIT_MS) return;
    lastLoggedAt.set(label, at);
    log(formatSlowTimer(elapsed, label));
  }

  function wrap(fn) {
    if (typeof fn !== 'function' || fn.__peerSlowTimer) return fn;
    function wrapped(...args) {
      const started = now();
      try {
        return fn.apply(this, args);
      } finally {
        note(started, fn);
      }
    }
    wrapped.__peerSlowTimer = true;
    try { Object.defineProperty(wrapped, 'name', { value: fn.name || 'anonymous' }); } catch { /* frozen */ }
    return wrapped;
  }

  function patchedTimeout(fn, delay, ...args) {
    return originalSetTimeout(wrap(fn), delay, ...args);
  }
  function patchedInterval(fn, delay, ...args) {
    return originalSetInterval(wrap(fn), delay, ...args);
  }
  patchedTimeout.__promisify__ = originalSetTimeout.__promisify__;
  patchedInterval.__promisify__ = originalSetInterval.__promisify__;
  timers.setTimeout = patchedTimeout;
  timers.setInterval = patchedInterval;
  timers.__peerSlowTimerInstalled = true;
  return function uninstall() {
    if (timers.setTimeout === patchedTimeout) timers.setTimeout = originalSetTimeout;
    if (timers.setInterval === patchedInterval) timers.setInterval = originalSetInterval;
    delete timers.__peerSlowTimerInstalled;
  };
}

if (process.versions.electron && slowTimerThresholdMs() > 0) installSlowTimerProbe();
