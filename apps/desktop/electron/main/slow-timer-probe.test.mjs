import assert from 'node:assert/strict';
import test from 'node:test';
import { callbackLabel, formatSlowTimer, installSlowTimerProbe } from './slow-timer-probe.mjs';

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
  assert.match(lines[0], /\[slow-timer\] ms=80 callback=syntheticLargeSerialize/);
  assert.equal(lines[0].includes(secret), false);
  uninstall();
});

test('string literals inside the callback source are redacted', () => {
  const secret = 'super-secret-plan-body';
  const fn = () => 'super-secret-plan-body';
  const label = callbackLabel(fn);
  assert.equal(label.includes(secret), false);
  assert.match(label, /"…"/);
  assert.match(formatSlowTimer(120.4, label), /^\[slow-timer\] ms=120 callback=/);
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
