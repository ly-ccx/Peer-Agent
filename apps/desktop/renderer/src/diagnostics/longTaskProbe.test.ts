import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRendererFrame, formatRendererLongTask, observeRendererFrames, observeRendererLongTasks, summarizeFrameGaps } from './longTaskProbe.ts';

test('renderer long task line keeps attribution names and drops unrelated body text', () => {
  const secret = 'super-secret-plan-body';
  const at = '2026-11-07T10:45:37.123';
  const line = formatRendererLongTask({
    duration: 87.6,
    name: 'self',
    attribution: [{ containerName: 'iframe', name: 'app.js' }],
  }, at);
  assert.equal(line, '[renderer-longtask] at=2026-11-07T10:45:37.123 ms=88 name=self via=iframe:app.js');
  const leaked = formatRendererLongTask({
    duration: 50,
    name: 'self',
    attribution: [{ name: `https://cdn.example/app.js?token=${secret}` }],
  });
  assert.equal(leaked.includes(secret), false);
  assert.match(leaked, /via=app\.js$/);
  const unrelated = { duration: 40, name: 'self', body: secret };
  assert.equal(formatRendererLongTask(unrelated).includes(secret), false);
});

test('long task names are truncated', () => {
  const line = formatRendererLongTask({ duration: 10, name: 'n'.repeat(400) });
  assert.ok(line.length < 200);
  assert.match(line, /name=n{120}/);
});

test('observeRendererLongTasks reports formatted entries and ignores unsupported observers', () => {
  const lines: string[] = [];
  let observed = false;
  class FakeObserver {
    callback: (list: { getEntries(): unknown[] }) => void;
    constructor(callback: (list: { getEntries(): unknown[] }) => void) { this.callback = callback; }
    observe() { observed = true; }
    disconnect() {}
    emit() { this.callback({ getEntries: () => [{ duration: 60, name: 'self' }] }); }
  }
  const observer = observeRendererLongTasks(FakeObserver as unknown as typeof PerformanceObserver, (line) => lines.push(line));
  assert.equal(observed, true);
  (observer as unknown as { emit(): void }).emit();
  assert.match(lines[0] ?? '', /^\[renderer-longtask\] at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} ms=60 name=self$/);
  assert.equal(typeof observeRendererLongTasks(undefined as unknown as typeof PerformanceObserver).disconnect, 'function');
});

test('frame summary names sustained sub-longtask gaps and stays quiet when frames are on time', () => {
  const at = '2026-11-07T10:45:37.123';
  assert.equal(summarizeFrameGaps([16, 16, 17, 15]), null);
  const summary = summarizeFrameGaps([16, 28, 40, 18, 36]);
  assert.deepEqual(summary, { frames: 5, busy: 3, maxMs: 40, meanMs: 28 });
  assert.equal(
    formatRendererFrame(summary!, at),
    '[renderer-frame] at=2026-11-07T10:45:37.123 windowMs=1000 frames=5 busy=3 max=40 mean=28',
  );
});

test('idle frame probe schedules one frame per second and samples only after a slow frame', () => {
  const lines: string[] = [];
  let clock = 0;
  const frames: Array<() => void> = [];
  const later: Array<() => void> = [];
  const request = (callback: FrameRequestCallback) => {
    frames.push(() => callback(clock));
    return 1;
  };
  const scheduleLater = (callback: () => void) => {
    later.push(callback);
    return 1;
  };
  const observer = observeRendererFrames(request, (line) => lines.push(line), () => clock, scheduleLater);
  assert.equal(frames.length, 0);
  assert.equal(later.length, 1);
  later.shift()?.();
  assert.equal(frames.length, 1);
  clock += 16;
  frames.shift()?.();
  assert.equal(lines.length, 0);
  assert.equal(frames.length, 0);
  assert.equal(later.length, 1);
  later.shift()?.();
  clock += 40;
  frames.shift()?.();
  assert.equal(frames.length, 1);
  clock = 2000;
  frames.shift()?.();
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /\[renderer-frame\] at=.* busy=2 max=1944/);
  assert.equal(lines[0]?.includes('super-secret'), false);
  observer.disconnect();
  const queuedFrames = frames.length;
  const queuedLater = later.length;
  later.shift()?.();
  frames.shift()?.();
  assert.equal(frames.length, Math.max(0, queuedFrames - 1));
  assert.equal(later.length, Math.max(0, queuedLater - 1));
  assert.equal(lines.length, 1);
});
