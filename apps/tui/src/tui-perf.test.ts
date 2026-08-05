import { describe, expect, test } from 'bun:test';
import { createTuiPerfRecorder } from './tui-perf.ts';

describe('tui perf recorder', () => {
  test('off mode is a no-op', () => {
    let now = 0;
    const recorder = createTuiPerfRecorder({ mode: 'off', now: () => now });
    const value = recorder.measure('work', () => {
      now += 12;
      return 42;
    });
    expect(value).toBe(42);
    expect(recorder.summary().metrics).toEqual({});
    expect(recorder.traceEvents()).toEqual([]);
  });

  test('summary aggregates durations and numeric fields', () => {
    let now = 0;
    const recorder = createTuiPerfRecorder({
      mode: 'summary',
      now: () => now,
      wallClock: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    for (const duration of [1, 2, 3, 4, 100]) {
      recorder.record('stream.flush', duration, { chars: duration, lane: 'stream' });
      now += duration;
    }
    const metric = recorder.summary().metrics['stream.flush'];
    expect(metric).toEqual({
      count: 5,
      totalMs: 110,
      p50Ms: 3,
      p95Ms: 100,
      p99Ms: 100,
      maxMs: 100,
      fields: { chars: 110 },
    });
  });

  test('measure records synchronous and asynchronous work', async () => {
    let now = 10;
    const recorder = createTuiPerfRecorder({ mode: 'summary', now: () => now });
    expect(recorder.measure('sync', () => {
      now += 7;
      return 'ok';
    })).toBe('ok');
    expect(await recorder.measureAsync('async', async () => {
      now += 9;
      return 'done';
    })).toBe('done');
    expect(recorder.summary().metrics.sync?.totalMs).toBe(7);
    expect(recorder.summary().metrics.async?.totalMs).toBe(9);
  });

  test('trace mode is bounded and reports dropped events', () => {
    let now = 0;
    const recorder = createTuiPerfRecorder({
      mode: 'trace',
      now: () => now++,
      maxTraceEvents: 2,
    });
    recorder.record('a', 1);
    recorder.record('b', 2);
    recorder.record('c', 3);
    expect(recorder.traceEvents().map((event) => event.name)).toEqual(['a', 'b']);
    expect(recorder.summary().droppedTraceEvents).toBe(1);
  });

  test('duration samples are bounded while totals remain exact', () => {
    const recorder = createTuiPerfRecorder({ mode: 'summary', maxDurationSamples: 2 });
    recorder.record('work', 5);
    recorder.record('work', 6);
    recorder.record('work', 100);
    const metric = recorder.summary().metrics.work;
    expect(metric?.count).toBe(3);
    expect(metric?.totalMs).toBe(111);
    expect(metric?.maxMs).toBe(100);
    expect(metric?.p95Ms).toBe(6);
  });
});
