/**
 * rc.38 的主进程忙态落在 RunTimers 下没有函数名的 JS 里。
 * 未符号化地址不能当成业务根因。这里只在定时器回调同步超过阈值时追加一行。
 *
 * 回调触发时只做两次计时。注册时把调用栈限到 8 帧并立刻收成「函数名@文件名:行号」，
 * 不保留 Error 或绝对路径，也不 toString 回调，因此模板字符串和源码首行不会进日志。
 * 回调的 this、参数、返回值和异常照原样传播。探针自己的失败不能盖住回调异常。
 *
 * 默认 100ms。PEER_AGENT_SLOW_TIMER_MS=0 关闭，设为正数则改阈值。
 * 定时器回调之外的阻塞记在事件循环延迟、流式 send 分段、计划正文
 * stringify/write 的字节数，以及慢的 console 调用上。这些行只有时间、
 * 次数和字节数。日志进启动进程的终端，并追加到
 * ~/.peer-agent/diagnostics/slow-timer.log。
 * 只在 Electron 主进程自动安装。node:timers 的具名导入不经过定时器包装。
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_THRESHOLD_MS = 100;
const RATE_LIMIT_MS = 10_000;
const MAX_LABEL = 320;
const MAX_LOG_BYTES = 256 * 1024;
const SEGMENT_WINDOW_MS = 1000;
const SEGMENT_SUMMARY_TOTAL_MS = 50;
const SEGMENT_SUMMARY_MAX_MS = 30;
const EVENT_LOOP_MAX_MS = 50;
const EVENT_LOOP_MEAN_MS = 10;
const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
const STREAM_CHANNELS = new Set([
  'chat:stream:delta',
  'chat:stream:thinking',
  'chat:stream:tool-call',
  'chat:stream:tool-result',
  'chat:stream:done',
  'chat:stream:error',
  'chat:stream:aborted',
]);
const PHASE_NAMES = new Set([
  'watch.sync',
  'watch.inventory',
  'watch.recover',
  'watch.runner',
  'watch.inputs',
  'watch.digest',
  'watch.publish',
  'watch.kick',
  'watch.continuation',
  'watch.snapshot',
  'watch.repair',
  'watch.ledger',
  'watch.readFacts',
  'watch.reconcile',
  'plan.normalize',
  'plan.reportRevision',
  'plan.catalog',
]);
const phaseBuckets = new Map();

/** 进程本地时间，用来和采样钟对齐。不含时区名以外的环境信息。 */
export function diagnosticStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function slowTimerThresholdMs(env = process.env) {
  const raw = env.PEER_AGENT_SLOW_TIMER_MS;
  if (raw === undefined || raw === '') return DEFAULT_THRESHOLD_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD_MS;
}

export function diagnosticLogPath(home = os.homedir()) {
  return path.join(home, '.peer-agent', 'diagnostics', 'slow-timer.log');
}

function captureSite() {
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = 8;
  try {
    return formatCallSite(new Error().stack);
  } finally {
    Error.stackTraceLimit = previous;
  }
}

/** 只留调用点的 basename 和行号，去掉用户目录。 */
export function formatCallSite(stack) {
  const lines = String(stack || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('at ') || line.includes('slow-timer-probe')) continue;
    const withFn = line.match(/^at (?:async )?([^[\]()\n]+?) \((?:.*[/\\])?([^/\\():]+):(\d+):\d+\)$/);
    if (withFn) return `${withFn[1].slice(0, 80)}@${withFn[2]}:${withFn[3]}`;
    const bare = line.match(/^at (?:.*[/\\])?([^/\\():]+):(\d+):\d+$/);
    if (bare) return `${bare[1]}:${bare[2]}`;
  }
  return 'unknown';
}

export function formatSlowTimer(elapsedMs, callbackName, site, at = diagnosticStamp()) {
  const name = String(callbackName || 'anonymous').slice(0, 80);
  const where = String(site || 'unknown').slice(0, 80);
  return `[slow-timer] at=${at} ms=${Math.round(elapsedMs)} callback=${name} site=${where}`.slice(0, MAX_LABEL);
}

export function diagnosticStreamSegment(channel) {
  return STREAM_CHANNELS.has(channel) ? channel : 'chat:stream:other';
}

export function shouldReportEventLoop({ maxMs = 0, meanMs = 0 } = {}, {
  maxThreshold = EVENT_LOOP_MAX_MS,
  meanThreshold = EVENT_LOOP_MEAN_MS,
} = {}) {
  return maxMs >= maxThreshold || meanMs >= meanThreshold;
}

export function formatEventLoopWindow({ at = diagnosticStamp(), maxMs = 0, meanMs = 0 } = {}) {
  return `[event-loop] at=${at} windowMs=1000 max=${Math.round(maxMs)} mean=${Math.round(meanMs)}`;
}

export function formatPlanWrite({ at = diagnosticStamp(), phase = 'write', ms = 0, bytes = 0 } = {}) {
  const kind = phase === 'stringify' ? 'stringify' : 'write';
  return `[plan-write] at=${at} phase=${kind} ms=${Math.round(ms)} bytes=${Math.max(0, Math.round(bytes))}`;
}

export function formatConsoleSlow({ at = diagnosticStamp(), method = 'log', ms = 0, argc = 0 } = {}) {
  const name = ['log', 'info', 'warn', 'error', 'debug'].includes(method) ? method : 'log';
  return `[console] at=${at} method=${name} ms=${Math.round(ms)} argc=${Math.max(0, Math.round(argc))}`;
}

const segmentBuckets = new Map();
let segmentWindowStart = 0;
let segmentSink = null;
let segmentThreshold = DEFAULT_THRESHOLD_MS;

export function setMainSegmentSink(sink, { thresholdMs = slowTimerThresholdMs(), now = performance.now() } = {}) {
  segmentSink = typeof sink === 'function' ? sink : null;
  segmentThreshold = thresholdMs;
  segmentWindowStart = now;
  segmentBuckets.clear();
}

export function recordMainSegment(name, elapsedMs, now = performance.now()) {
  if (!segmentSink) return;
  const safe = STREAM_CHANNELS.has(name) || name === 'chat:stream:other' ? name : 'chat:stream:other';
  const elapsed = Number(elapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < 0) return;
  if (elapsed >= segmentThreshold) {
    try {
      segmentSink(`[main-block] at=${diagnosticStamp()} name=${safe} ms=${Math.round(elapsed)}`);
    } catch { /* 诊断不能影响发送。 */ }
  }
  const bucket = segmentBuckets.get(safe) ?? { total: 0, max: 0, calls: 0 };
  bucket.total += elapsed;
  bucket.max = Math.max(bucket.max, elapsed);
  bucket.calls += 1;
  segmentBuckets.set(safe, bucket);
  if (now - segmentWindowStart >= SEGMENT_WINDOW_MS) flushMainSegments(now);
}

export function flushMainSegments(now = performance.now()) {
  if (!segmentSink) return;
  const windowMs = Math.max(0, Math.round(now - segmentWindowStart));
  segmentWindowStart = now;
  const at = diagnosticStamp();
  for (const [name, bucket] of segmentBuckets) {
    if (bucket.max < SEGMENT_SUMMARY_MAX_MS && bucket.total < SEGMENT_SUMMARY_TOTAL_MS) continue;
    try {
      segmentSink(`[main-segment] at=${at} name=${name} totalMs=${Math.round(bucket.total)} maxMs=${Math.round(bucket.max)} calls=${bucket.calls} windowMs=${windowMs}`);
    } catch { /* 诊断不能影响发送。 */ }
  }
  segmentBuckets.clear();
}

export function installConsoleSlowProbe({
  consoleObject = console,
  thresholdMs = slowTimerThresholdMs(),
  log = (line) => console.info(line),
  now = () => performance.now(),
} = {}) {
  if (!(thresholdMs > 0)) return () => {};
  const originals = new Map();
  let noting = false;
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = consoleObject[method];
    if (typeof original !== 'function' || original.__peerConsoleSlow) continue;
    originals.set(method, original);
    const bound = original.bind(consoleObject);
    function wrapped(...args) {
      const started = now();
      try {
        // 拆出来调用时仍绑定原来的 console，避免原生方法因 this 丢失抛出。
        return bound(...args);
      } finally {
        try {
          const elapsed = now() - started;
          if (!noting && elapsed >= thresholdMs) {
            noting = true;
            try { log(formatConsoleSlow({ method, ms: elapsed, argc: args.length })); }
            finally { noting = false; }
          }
        } catch {
          // 计时或记日志失败不能替换原来的返回值或异常。
        }
      }
    }
    wrapped.__peerConsoleSlow = true;
    consoleObject[method] = wrapped;
  }
  return function uninstall() {
    for (const [method, original] of originals) {
      if (consoleObject[method]?.__peerConsoleSlow) consoleObject[method] = original;
    }
  };
}

export function createDiagnosticWriter({
  file = diagnosticLogPath(),
  maxBytes = MAX_LOG_BYTES,
  mkdir = mkdirSync,
  append = appendFileSync,
  stat = statSync,
} = {}) {
  return function write(line) {
    const safe = String(line).replace(/[\r\n]/g, ' ').slice(0, 500);
    try {
      mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = stat(file).size; }
      catch (error) { if (error?.code !== 'ENOENT') return; }
      if (size > 0 && size + safe.length + 1 > maxBytes) {
        try { unlinkSync(`${file}.2`); } catch (error) { if (error?.code !== 'ENOENT') return; }
        try { renameSync(`${file}.1`, `${file}.2`); } catch (error) { if (error?.code !== 'ENOENT') return; }
        try { renameSync(file, `${file}.1`); } catch (error) { if (error?.code !== 'ENOENT') return; }
      }
      append(file, `${safe}\n`, 'utf8');
    } catch {
      // 诊断不能影响定时器回调。
    }
  };
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
  let noting = false;

  function note(started, fn, site) {
    if (noting) return;
    noting = true;
    try {
      const elapsed = now() - started;
      if (elapsed < thresholdMs) return;
      const label = `${fn?.name || 'anonymous'}@${site}`;
      const at = now();
      if (at - (lastLoggedAt.get(label) ?? -Infinity) < RATE_LIMIT_MS) return;
      lastLoggedAt.set(label, at);
      log(formatSlowTimer(elapsed, fn?.name || 'anonymous', site));
    } catch {
      // 探针失败不能替换回调自己的异常。
    } finally {
      noting = false;
    }
  }

  function wrap(fn, site) {
    if (typeof fn !== 'function' || fn.__peerSlowTimer) return fn;
    function wrapped(...args) {
      const started = now();
      try {
        return fn.apply(this, args);
      } finally {
        note(started, fn, site);
      }
    }
    wrapped.__peerSlowTimer = true;
    return wrapped;
  }

  function patchedTimeout(fn, delay, ...args) {
    const site = typeof fn === 'function' ? captureSite() : '';
    return originalSetTimeout(wrap(fn, site), delay, ...args);
  }
  function patchedInterval(fn, delay, ...args) {
    const site = typeof fn === 'function' ? captureSite() : '';
    return originalSetInterval(wrap(fn, site), delay, ...args);
  }
  if (originalSetTimeout[PROMISIFY]) patchedTimeout[PROMISIFY] = originalSetTimeout[PROMISIFY];
  if (originalSetInterval[PROMISIFY]) patchedInterval[PROMISIFY] = originalSetInterval[PROMISIFY];
  timers.setTimeout = patchedTimeout;
  timers.setInterval = patchedInterval;
  timers.__peerSlowTimerInstalled = true;
  return function uninstall() {
    if (timers.setTimeout === patchedTimeout) timers.setTimeout = originalSetTimeout;
    if (timers.setInterval === patchedInterval) timers.setInterval = originalSetInterval;
    delete timers.__peerSlowTimerInstalled;
  };
}

export function hookRendererLongTaskConsole(app, write) {
  if (!app || typeof app.on !== 'function') return;
  const attach = () => {
    app.on('web-contents-created', (_event, contents) => {
      contents?.on?.('console-message', (event, _level, message) => {
        const text = typeof event?.message === 'string'
          ? event.message
          : (typeof message === 'string' ? message : '');
        if (text.startsWith('[renderer-longtask] ') || text.startsWith('[renderer-frame] ')) write(text);
      });
    });
  };
  if (app.isReady?.()) attach();
  else app.once?.('ready', attach);
}

export function recordDiagnosticPhase(name, fields) {
  if (!PHASE_NAMES.has(name) || !fields || typeof fields !== 'object') return;
  const bucket = phaseBuckets.get(name) || { calls: 0, hit: 0, miss: 0, sawCache: false, ms: 0 };
  bucket.calls += 1;
  if (fields.hit === 1 || fields.hit === 0) {
    bucket.sawCache = true;
    if (fields.hit === 1) bucket.hit += 1;
    else bucket.miss += 1;
  }
  if (Number.isFinite(fields.ms) && fields.ms > 0) bucket.ms += fields.ms;
  if (Number.isFinite(fields.plans) && fields.plans >= 0) {
    bucket.plans = Math.max(bucket.plans || 0, Math.round(fields.plans));
  }
  phaseBuckets.set(name, bucket);
}

export function formatDiagnosticPhase(name, fields = {}, at = diagnosticStamp()) {
  if (!PHASE_NAMES.has(name)) return '';
  const parts = [`[phase] at=${at}`, `name=${name}`];
  if (Number.isFinite(fields.calls)) parts.push(`calls=${Math.round(fields.calls)}`);
  if (fields.sawCache === true) {
    parts.push(`hit=${Math.round(Number(fields.hit) || 0)}`);
    parts.push(`miss=${Math.round(Number(fields.miss) || 0)}`);
  }
  if (Number.isFinite(fields.ms)) parts.push(`ms=${Math.round(fields.ms)}`);
  if (Number.isFinite(fields.plans)) parts.push(`plans=${Math.round(fields.plans)}`);
  return parts.join(' ');
}

export function flushDiagnosticPhases(log, at = diagnosticStamp()) {
  if (typeof log !== 'function') {
    phaseBuckets.clear();
    return;
  }
  for (const [name, bucket] of phaseBuckets) {
    const watch = name.startsWith('watch.');
    if ((!watch || name === 'watch.ledger') && bucket.ms < 20 && bucket.miss === 0) continue;
    const line = formatDiagnosticPhase(name, bucket, at);
    if (line) log(line);
  }
  phaseBuckets.clear();
}

function watchEventLoop(log) {
  return import('node:perf_hooks').then(({ monitorEventLoopDelay }) => {
    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const timer = setInterval(() => {
      try {
        const sample = { maxMs: histogram.max / 1e6, meanMs: histogram.mean / 1e6 };
        histogram.reset();
        flushMainSegments();
        flushDiagnosticPhases(log);
        if (!shouldReportEventLoop(sample)) return;
        log(formatEventLoopWindow(sample));
      } catch {
        // 事件循环采样失败不能变成未捕获异常。
      }
    }, SEGMENT_WINDOW_MS);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      histogram.disable();
    };
  }).catch(() => {});
}

function installForElectron() {
  if (!process.versions.electron || !(slowTimerThresholdMs() > 0)) return;
  const write = createDiagnosticWriter();
  const log = (line) => {
    console.info(line);
    write(line);
  };
  installSlowTimerProbe({ log });
  setMainSegmentSink(log);
  installConsoleSlowProbe({ log });
  watchEventLoop(log);
  import('electron').then(({ app }) => hookRendererLongTaskConsole(app, write)).catch(() => {});
  // 计划写盘和诊断相位都走 runtime-node 的 dist 子路径。打包后的 asar 只保留这份 dist，
  // 而且和主进程实际执行的是同一个模块实例。导入失败不能阻止主进程启动。
  import('@peer-agent/runtime-node/goal-plan-files')
    .then(({ setJsonWriteObserver }) => {
      setJsonWriteObserver((sample) => {
        log(formatPlanWrite(sample));
      });
    })
    .catch(() => {});
  import('@peer-agent/runtime-node/diagnostic-phase')
    .then(({ setDiagnosticPhaseObserver }) => {
      setDiagnosticPhaseObserver((name, fields) => recordDiagnosticPhase(name, fields));
    })
    .catch(() => {});
}

try {
  installForElectron();
} catch {
  // 诊断安装失败不能阻止主进程启动。
}
