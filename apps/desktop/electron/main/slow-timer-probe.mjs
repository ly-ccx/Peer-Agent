/**
 * rc.38 的主进程忙态落在 RunTimers 下没有函数名的 JS 里。
 * 未符号化地址不能当成业务根因。这里只在定时器回调同步超过阈值时追加一行。
 *
 * 回调触发时只做两次计时。注册时把调用栈限到 8 帧并立刻收成「函数名@文件名:行号」，
 * 不保留 Error 或绝对路径，也不 toString 回调，因此模板字符串和源码首行不会进日志。
 * 回调的 this、参数、返回值和异常照原样传播。探针自己的失败不能盖住回调异常。
 *
 * 默认 100ms。PEER_AGENT_SLOW_TIMER_MS=0 关闭，设为正数则改阈值。
 * 日志同时进启动该进程的终端，并追加到 ~/.peer-agent/diagnostics/slow-timer.log。
 * 只在 Electron 主进程自动安装。node:timers 的具名导入不经过这里。
 */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_THRESHOLD_MS = 100;
const RATE_LIMIT_MS = 10_000;
const MAX_LABEL = 160;
const MAX_LOG_BYTES = 256 * 1024;
const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');

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

export function formatSlowTimer(elapsedMs, callbackName, site) {
  const name = String(callbackName || 'anonymous').slice(0, 80);
  const where = String(site || 'unknown').slice(0, 80);
  return `[slow-timer] ms=${Math.round(elapsedMs)} callback=${name} site=${where}`.slice(0, MAX_LABEL);
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
      try {
        if (stat(file).size > maxBytes) return;
      } catch (error) {
        if (error?.code !== 'ENOENT') return;
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
        if (text.startsWith('[renderer-longtask] ')) write(text);
      });
    });
  };
  if (app.isReady?.()) attach();
  else app.once?.('ready', attach);
}

function installForElectron() {
  if (!process.versions.electron || !(slowTimerThresholdMs() > 0)) return;
  const write = createDiagnosticWriter();
  installSlowTimerProbe({
    log(line) {
      console.info(line);
      write(line);
    },
  });
  import('electron').then(({ app }) => hookRendererLongTaskConsole(app, write)).catch(() => {});
}

installForElectron();
