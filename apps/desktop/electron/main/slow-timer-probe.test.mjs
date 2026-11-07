import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createDiagnosticWriter,
  diagnosticLogPath,
  diagnosticStreamSegment,
  flushMainSegments,
  formatCallSite,
  formatConsoleSlow,
  formatEventLoopWindow,
  formatPlanWrite,
  formatSlowTimer,
  hookRendererLongTaskConsole,
  installConsoleSlowProbe,
  installSlowTimerProbe,
  recordMainSegment,
  setMainSegmentSink,
  shouldReportEventLoop,
  shouldReportPlanWrite,
} from './slow-timer-probe.mjs';

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, delay, ...args) {
      const id = scheduled.length + 1;
      scheduled.push({ fn, delay, args, id, kind: 'timeout' });
      return id;
    },
    setInterval(fn, delay, ...args) {
      const id = scheduled.length + 1;
      scheduled.push({ fn, delay, args, id, kind: 'interval' });
      return id;
    },
  };
}

test('slow timer log names the callback and drops argument text', () => {
  const secret = 'super-secret-plan-body';
  const lines = [];
  let clock = 0;
  const timers = fakeTimers();
  const uninstall = installSlowTimerProbe({
    thresholdMs: 50,
    log: (line) => lines.push(line),
    timers,
    now: () => clock,
  });
  function syntheticLargeSerialize() {
    clock += 80;
  }
  timers.setTimeout(syntheticLargeSerialize, 0, secret);
  timers.scheduled[0].fn();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[slow-timer\] at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} ms=80 callback=syntheticLargeSerialize/);
  assert.equal(lines[0].includes(secret), false);
  uninstall();
});

test('call site keeps basename and drops home paths, templates, and source text', () => {
  const secret = 'super-secret-plan-body';
  const stack = [
    'Error',
    '    at patchedTimeout (/opt/app/apps/desktop/electron/main/slow-timer-probe.mjs:90:5)',
    '    at scheduleRunner (file:///Users/yinliang/Documents/Develop/Peer-Agent/packages/runtime-node/src/goal-plan-store.mjs:664:17)',
    `    at leak (/Users/yinliang/.peer-agent/${secret}.js:3:1)`,
  ].join('\n');
  const site = formatCallSite(stack);
  assert.equal(site, 'scheduleRunner@goal-plan-store.mjs:664');
  assert.equal(site.includes('yinliang'), false);
  assert.equal(site.includes(secret), false);
  const fn = () => `token=${secret}`;
  const lines = [];
  let clock = 0;
  const timers = fakeTimers();
  const uninstall = installSlowTimerProbe({
    thresholdMs: 10,
    log: (line) => lines.push(line),
    timers,
    now: () => {
      const value = clock;
      clock += 40;
      return value;
    },
  });
  timers.setTimeout(fn, 0, secret);
  timers.scheduled[0].fn(secret);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(secret), false);
  assert.equal(lines[0].includes('token='), false);
  assert.match(lines[0], /callback=fn /);
  uninstall();
});

test('callbacks under the threshold and repeats inside the rate limit stay quiet', () => {
  const lines = [];
  let clock = 0;
  const timers = fakeTimers();
  const uninstall = installSlowTimerProbe({
    thresholdMs: 50,
    log: (line) => lines.push(line),
    timers,
    now: () => clock,
  });
  function burn() { clock += 10; }
  function burnSlow() { clock += 70; }
  timers.setTimeout(burn, 0);
  timers.scheduled[0].fn();
  timers.setTimeout(burnSlow, 0);
  timers.scheduled[1].fn();
  clock += 1000;
  timers.scheduled[1].fn();
  assert.equal(lines.length, 1);
  uninstall();
});

test('threshold zero does not install', () => {
  const timers = fakeTimers();
  const original = timers.setTimeout;
  const uninstall = installSlowTimerProbe({ thresholdMs: 0, timers });
  assert.equal(timers.setTimeout, original);
  assert.equal(typeof uninstall, 'function');
});

test('wrapper keeps this, arguments, return value, thrown errors, and timer args', async () => {
  const timers = fakeTimers();
  const uninstall = installSlowTimerProbe({ thresholdMs: 10_000, timers, log() {} });
  function identity() { return 7; }
  timers.setTimeout(identity, 12, 'kept');
  assert.equal(timers.scheduled[0].delay, 12);
  assert.deepEqual(timers.scheduled[0].args, ['kept']);
  assert.equal(timers.scheduled[0].fn.call({ tag: 'owner' }, 'kept'), 7);
  const seen = {};
  function method(arg) {
    seen.tag = this.tag;
    seen.arg = arg;
    throw new Error('probe-boom');
  }
  timers.setTimeout(method, 0, 'payload');
  assert.throws(() => timers.scheduled[1].fn.call({ tag: 'owner' }, 'payload'), /probe-boom/);
  assert.equal(seen.tag, 'owner');
  assert.equal(seen.arg, 'payload');
  uninstall();

  const host = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
  };
  const remove = installSlowTimerProbe({ thresholdMs: 10_000, timers: host, log() {} });
  try {
    const wrapped = await new Promise((resolve) => {
      host.setTimeout(function cb(arg) {
        resolve({ arg, ctor: this?.constructor?.name ?? '' });
      }, 0, 'payload');
    });
    const baseline = await new Promise((resolve) => {
      globalThis.setTimeout(function cb(arg) {
        resolve({ arg, ctor: this?.constructor?.name ?? '' });
      }, 0, 'payload');
    });
    assert.equal(wrapped.arg, 'payload');
    assert.equal(wrapped.ctor, baseline.ctor);
  } finally {
    remove();
  }
});

test('probe failures do not replace the callback error or recurse through logging', () => {
  const timers = fakeTimers();
  let logs = 0;
  const uninstall = installSlowTimerProbe({
    thresholdMs: 1,
    timers,
    now: () => {
      logs += 1;
      if (logs > 1) throw new Error('clock failed');
      return 0;
    },
    log() { throw new Error('log failed'); },
  });
  timers.setTimeout(function boom() { throw new Error('callback-failed'); }, 0);
  assert.throws(() => timers.scheduled[0].fn(), /callback-failed/);
  uninstall();
});

test('slow path does not stringify the callback, and nested schedules stay bounded', () => {
  const timers = fakeTimers();
  const lines = [];
  const uninstall = installSlowTimerProbe({
    thresholdMs: 1,
    timers,
    log: (line) => lines.push(line),
    now: (() => {
      let value = 0;
      return () => value += 5;
    })(),
  });
  function named() {}
  named.toString = () => { throw new Error('source must stay unread'); };
  function tick() { timers.setTimeout(tick, 0); }
  timers.setTimeout(named, 0);
  timers.scheduled[0].fn();
  timers.setTimeout(tick, 0);
  for (let i = 0; i < 8; i += 1) timers.scheduled.at(-1).fn();
  assert.equal(lines.some((line) => line.includes('callback=named ')), true);
  assert.equal(lines.some((line) => line.includes('source must stay unread')), false);
  uninstall();
});

test('renderer diagnostic lines are copied and other console text is not', () => {
  const lines = [];
  const appListeners = {};
  const contentsListeners = {};
  const app = {
    isReady: () => false,
    once(name, fn) { appListeners[name] = fn; },
    on(name, fn) { appListeners[name] = fn; },
  };
  hookRendererLongTaskConsole(app, (line) => lines.push(line));
  appListeners.ready();
  const contents = { on(name, fn) { contentsListeners[name] = fn; } };
  appListeners['web-contents-created'](null, contents);
  contentsListeners['console-message']({ message: '[renderer-longtask] at=2026-11-07T10:45:37.123 ms=10 name=self via=app.js' });
  contentsListeners['console-message']({ message: '[renderer-frame] at=2026-11-07T10:45:37.123 windowMs=1000 frames=60 busy=4 max=40 mean=22' });
  contentsListeners['console-message'](null, 1, 'plan body super-secret-plan-body');
  assert.deepEqual(lines, [
    '[renderer-longtask] at=2026-11-07T10:45:37.123 ms=10 name=self via=app.js',
    '[renderer-frame] at=2026-11-07T10:45:37.123 windowMs=1000 frames=60 busy=4 max=40 mean=22',
  ]);
});

test('stream segments name the channel and omit payload text', () => {
  const secret = 'super-secret-plan-body';
  const lines = [];
  setMainSegmentSink((line) => lines.push(line), { thresholdMs: 100, now: 0 });
  try {
    assert.equal(diagnosticStreamSegment(`chat:stream:delta?token=${secret}`), 'chat:stream:other');
    recordMainSegment('chat:stream:delta', 20, 10);
    recordMainSegment('chat:stream:delta', 40, 20);
    recordMainSegment(diagnosticStreamSegment(`token=${secret}`), 40, 30);
    recordMainSegment('chat:stream:delta', 150, 40);
    flushMainSegments(1000);
    const text = lines.join('\n');
    assert.equal(text.includes(secret), false);
    assert.match(text, /\[main-block\] at=\d{4}.* name=chat:stream:delta ms=150/);
    assert.match(text, /\[main-segment\] at=\d{4}.* name=chat:stream:delta /);
    assert.match(text, /name=chat:stream:other /);
  } finally {
    setMainSegmentSink(null);
  }
});

test('event loop, plan write, and slow console lines keep only durations', () => {
  const secret = 'super-secret-plan-body';
  assert.equal(shouldReportEventLoop({ maxMs: 12, meanMs: 2 }), false);
  assert.equal(shouldReportEventLoop({ maxMs: 80, meanMs: 4 }), true);
  assert.match(formatEventLoopWindow({ at: '2026-11-07T10:45:37.123', maxMs: 80.2, meanMs: 11.4 }),
    /\[event-loop\] at=2026-11-07T10:45:37.123 windowMs=1000 max=80 mean=11/);
  assert.equal(shouldReportPlanWrite({ ms: 4, bytes: 5000 }), false);
  assert.equal(shouldReportPlanWrite({ ms: 4, bytes: 90_000_000 }), true);
  const planLine = formatPlanWrite({ at: '2026-11-07T10:45:37.123', phase: 'stringify', ms: 800, bytes: 93_014_593 });
  assert.equal(planLine.includes(secret), false);
  assert.match(planLine, /phase=stringify ms=800 bytes=93014593/);
  const lines = [];
  let clock = 0;
  const consoleObject = {
    info(...args) {
      clock += 80;
      return args.length;
    },
  };
  const uninstall = installConsoleSlowProbe({
    consoleObject,
    thresholdMs: 50,
    log: (line) => lines.push(line),
    now: () => clock,
  });
  consoleObject.info(secret);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(secret), false);
  assert.match(lines[0], /\[console\] at=.* method=info ms=80 argc=1/);
  assert.equal(formatConsoleSlow({ at: '2026-11-07T10:45:37.123', method: 'info', ms: 80, argc: 1 }).includes(secret), false);
  uninstall();
});

test('diagnostic file stores one sanitized line under ~/.peer-agent and stops past the cap', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'slow-timer-'));
  const file = diagnosticLogPath(home);
  try {
    const write = createDiagnosticWriter({ file, maxBytes: 20 });
    write('[slow-timer] ms=10 callback=burn site=main.mjs:1\nnext-line');
    const text = readFileSync(file, 'utf8');
    assert.equal(text, '[slow-timer] ms=10 callback=burn site=main.mjs:1 next-line\n');
    write('[slow-timer] ms=11 callback=again site=main.mjs:2');
    assert.equal(readFileSync(file, 'utf8'), text);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
