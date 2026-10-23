import assert from 'node:assert/strict';
import test from 'node:test';
import { animateVisual, motionDurationMs, watchVisualMotion } from './visualMotion.ts';

function fixture(allowed = true) {
  let enabled = allowed, changes: (() => void) | null = null, sequence = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const environment = { allowed: () => enabled, subscribe(fn: () => void) { changes = fn; return () => { changes = null; }; } };
  return { environment, timers, change(value: boolean) { enabled = value; changes?.(); },
    schedule(fn: () => void, ms: number) { const id = ++sequence; timers.set(id, { fn, ms }); return id as unknown as ReturnType<typeof setTimeout>; },
    clear(id: ReturnType<typeof setTimeout>) { timers.delete(id as unknown as number); },
    fire() { const next = timers.entries().next().value!; timers.delete(next[0]); next[1].fn(); } };
}
function animation() {
  let resolve!: () => void, reject!: (reason?: unknown) => void, ready!: () => void, cancelled = 0;
  const value = { finished: new Promise<void>((yes, no) => { resolve = yes; reject = no; }), ready: new Promise<void>(yes => { ready = yes; }),
    cancel() { cancelled++; }, currentTime: 0, playbackRate: 1, effect: { getComputedTiming: () => ({ endTime: 200 }) } };
  return { value: value as unknown as Animation, resolve, reject, ready, cancelled: () => cancelled };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('static/hidden preference completes once without waiting; missing animation API remains usable', () => {
  const f = fixture(false); let count = 0;
  const motion = watchVisualMotion([], () => count++, { ...f, durationMs: 200 });
  assert.equal(count, 1); assert.equal(f.timers.size, 0); motion.finish(); motion.cancel(); assert.equal(count, 1);
  let completed = false; animateVisual(null, [], { duration: 200 }, () => { completed = true; }); assert.equal(completed, true);
});
test('rejected finished, fallback and explicit completion compete for one cleanup', async () => {
  const f = fixture(), a = animation(); let count = 0;
  const motion = watchVisualMotion([a.value], () => count++, f);
  a.reject(Error('cancelled')); await flush(); motion.finish();
  assert.equal(count, 1); assert.equal(a.cancelled(), 1); assert.equal(f.timers.size, 0);
});
test('a never-started or never-finished animation cannot strand a disappearing surface', async () => {
  const f = fixture(), a = animation(); let count = 0;
  watchVisualMotion([a.value], () => count++, f);
  assert.equal([...f.timers.values()][0]!.ms, 2000); f.fire(); a.ready(); a.resolve(); await flush(); assert.equal(count, 1);
  const next = fixture(), b = animation(); watchVisualMotion([b.value], () => count++, { ...next, durationMs: 200 });
  b.ready(); await flush(); assert.equal([...next.timers.values()][0]!.ms, 260); next.fire(); assert.equal(count, 2);
});
test('preference changes interrupt motion, while reversal/unmount cancels without removing the reopened object', async () => {
  const f = fixture(), a = animation(); let count = 0;
  const old = watchVisualMotion([a.value], () => count++, f);
  old.cancel(); a.resolve(); await flush(); assert.equal(count, 0); assert.equal(f.timers.size, 0);
  const b = animation(); watchVisualMotion([b.value], () => count++, f);
  f.change(false); assert.equal(count, 1); assert.equal(b.cancelled(), 1); assert.equal(f.timers.size, 0);
  f.change(true); assert.equal(count, 1, 'resuming a page cannot replay an old exit');
});
test('computed time parsing accepts seconds, zero and invalid fallback without introducing new timing values', () => {
  assert.equal(motionDurationMs('0.2s'), 200); assert.equal(motionDurationMs('0ms'), 0);
  assert.equal(motionDurationMs('-2ms', 120), 120); assert.equal(motionDurationMs('infinite', 320), 320);
});
