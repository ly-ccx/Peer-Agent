import assert from 'node:assert/strict';
import test from 'node:test';
import { createForegroundRefreshLoop } from './foregroundRefreshState.ts';

test('foreground checking is bounded, non-overlapping, paused when hidden, and retired on teardown', async () => {
  let foreground = true, reads = 0, sequence = 0, finish!: () => void;
  const timers = new Map<number, { read: () => void; delay: number }>();
  const loop = createForegroundRefreshLoop({ check: () => { reads++; return new Promise<void>(done => { finish = done; }); }, foreground: () => foreground,
    schedule(read, delay) { timers.set(++sequence, { read, delay }); return sequence; }, cancel(timer) { timers.delete(timer as number); } });
  const tick = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(timer => timer.read()); };
  assert.equal(timers.size, 0); loop.start(); assert.equal([...timers.values()][0]!.delay, 5000); tick(); assert.equal(reads, 1);
  loop.wake(); tick(); assert.equal(reads, 1); // the first host read has not finished
  foreground = false; loop.wake(); assert.equal(timers.size, 0); finish(); await Promise.resolve(); await Promise.resolve(); assert.equal(timers.size, 0);
  foreground = true; loop.wake(); tick(); assert.equal(reads, 2); loop.stop(); finish(); await Promise.resolve(); await Promise.resolve(); assert.equal(timers.size, 0);
});
test('a failed check does not create a success fact or an unhandled promise and can be stopped', async () => {
  let callback!: () => void, timers = 0;
  const loop = createForegroundRefreshLoop({ check: async () => { throw Error('host read failed'); }, foreground: () => true,
    schedule(read) { callback = read; timers++; return timers; }, cancel() {} });
  loop.start(); callback(); await Promise.resolve(); await Promise.resolve(); assert.equal(timers, 2); loop.stop();
});
