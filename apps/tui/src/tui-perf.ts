import { appendFileSync, mkdirSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';

export type TuiPerfMode = 'off' | 'summary' | 'trace';

export interface TuiPerfEventFields {
  readonly lane?: string;
  readonly count?: number;
  readonly chars?: number;
  readonly bytes?: number;
  readonly [key: string]: string | number | boolean | undefined;
}

export interface TuiPerfEvent {
  readonly name: string;
  readonly atMs: number;
  readonly durationMs: number;
  readonly fields?: TuiPerfEventFields;
}

export interface TuiPerfMetricSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly fields: Readonly<Record<string, number>>;
}

export interface TuiPerfSummary {
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly metrics: Readonly<Record<string, TuiPerfMetricSummary>>;
  readonly droppedTraceEvents: number;
}

interface MutableMetric {
  count: number;
  totalMs: number;
  maxMs: number;
  durations: number[];
  fields: Record<string, number>;
}

export interface TuiPerfRecorder {
  readonly mode: TuiPerfMode;
  readonly enabled: boolean;
  record(name: string, durationMs?: number, fields?: TuiPerfEventFields): void;
  measure<T>(name: string, run: () => T, fields?: TuiPerfEventFields): T;
  measureAsync<T>(name: string, run: () => Promise<T>, fields?: TuiPerfEventFields): Promise<T>;
  summary(): TuiPerfSummary;
  traceEvents(): readonly TuiPerfEvent[];
  reset(): void;
}

const MAX_DURATION_SAMPLES = 2_048;
const MAX_TRACE_EVENTS = 20_000;

function parseMode(value: string | undefined): TuiPerfMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === '0' || normalized === 'false' || normalized === 'off') return 'off';
  if (normalized === 'trace') return 'trace';
  return 'summary';
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

export function createTuiPerfRecorder(options: {
  readonly mode?: TuiPerfMode;
  readonly now?: () => number;
  readonly wallClock?: () => Date;
  readonly maxDurationSamples?: number;
  readonly maxTraceEvents?: number;
} = {}): TuiPerfRecorder {
  const mode = options.mode ?? 'off';
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => new Date());
  const maxDurationSamples = options.maxDurationSamples ?? MAX_DURATION_SAMPLES;
  const maxTraceEvents = options.maxTraceEvents ?? MAX_TRACE_EVENTS;
  const metrics = new Map<string, MutableMetric>();
  const events: TuiPerfEvent[] = [];
  let droppedTraceEvents = 0;
  let startedAt = wallClock();
  let startedAtMs = now();

  const record = (name: string, durationMs = 0, fields?: TuiPerfEventFields): void => {
    if (mode === 'off') return;
    const safeDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
    let metric = metrics.get(name);
    if (!metric) {
      metric = { count: 0, totalMs: 0, maxMs: 0, durations: [], fields: {} };
      metrics.set(name, metric);
    }
    metric.count += 1;
    metric.totalMs += safeDuration;
    metric.maxMs = Math.max(metric.maxMs, safeDuration);
    if (metric.durations.length < maxDurationSamples) metric.durations.push(safeDuration);
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          metric.fields[key] = (metric.fields[key] ?? 0) + value;
        }
      }
    }
    if (mode === 'trace') {
      if (events.length < maxTraceEvents) {
        events.push({ name, atMs: now() - startedAtMs, durationMs: safeDuration, fields });
      } else {
        droppedTraceEvents += 1;
      }
    }
  };

  return {
    mode,
    enabled: mode !== 'off',
    record,
    measure<T>(name: string, run: () => T, fields?: TuiPerfEventFields): T {
      if (mode === 'off') return run();
      const start = now();
      try {
        return run();
      } finally {
        record(name, now() - start, fields);
      }
    },
    async measureAsync<T>(name: string, run: () => Promise<T>, fields?: TuiPerfEventFields): Promise<T> {
      if (mode === 'off') return run();
      const start = now();
      try {
        return await run();
      } finally {
        record(name, now() - start, fields);
      }
    },
    summary(): TuiPerfSummary {
      const result: Record<string, TuiPerfMetricSummary> = {};
      for (const [name, metric] of metrics) {
        const sorted = [...metric.durations].sort((a, b) => a - b);
        result[name] = {
          count: metric.count,
          totalMs: metric.totalMs,
          p50Ms: percentile(sorted, 0.5),
          p95Ms: percentile(sorted, 0.95),
          p99Ms: percentile(sorted, 0.99),
          maxMs: metric.maxMs,
          fields: { ...metric.fields },
        };
      }
      return {
        startedAt: startedAt.toISOString(),
        elapsedMs: Math.max(0, now() - startedAtMs),
        metrics: result,
        droppedTraceEvents,
      };
    },
    traceEvents: () => [...events],
    reset(): void {
      metrics.clear();
      events.length = 0;
      droppedTraceEvents = 0;
      startedAt = wallClock();
      startedAtMs = now();
    },
  };
}

export const tuiPerf = createTuiPerfRecorder({
  mode: parseMode(process.env.PEER_TUI_PERF),
});

export async function flushTuiPerf(options: {
  readonly outputPath?: string;
  readonly writeSummary?: (text: string) => void;
} = {}): Promise<TuiPerfSummary | null> {
  if (!tuiPerf.enabled) return null;
  const summary = tuiPerf.summary();
  const outputPath = options.outputPath ?? process.env.PEER_TUI_PERF_OUTPUT;
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    const payload = tuiPerf.mode === 'trace'
      ? { summary, trace: tuiPerf.traceEvents() }
      : { summary };
    await appendFile(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
  const writeSummary = options.writeSummary ?? ((text: string) => process.stderr.write(text));
  writeSummary(`[peer:tui:perf] ${JSON.stringify(summary)}\n`);
  return summary;
}

export function flushTuiPerfSync(options: {
  readonly outputPath?: string;
  readonly writeSummary?: (text: string) => void;
} = {}): TuiPerfSummary | null {
  if (!tuiPerf.enabled) return null;
  const summary = tuiPerf.summary();
  const outputPath = options.outputPath ?? process.env.PEER_TUI_PERF_OUTPUT;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    const payload = tuiPerf.mode === 'trace'
      ? { summary, trace: tuiPerf.traceEvents() }
      : { summary };
    appendFileSync(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');
  }
  const writeSummary = options.writeSummary ?? ((text: string) => process.stderr.write(text));
  writeSummary(`[peer:tui:perf] ${JSON.stringify(summary)}\n`);
  return summary;
}

export function recordTuiPerf(name: string, durationMs = 0, fields?: TuiPerfEventFields): void {
  tuiPerf.record(name, durationMs, fields);
}

export function measureTuiPerf<T>(name: string, run: () => T, fields?: TuiPerfEventFields): T {
  return tuiPerf.measure(name, run, fields);
}

export function tuiPerfNow(): number {
  return performance.now();
}

export const TUI_PERF_LIMITS = {
  maxDurationSamples: MAX_DURATION_SAMPLES,
  maxTraceEvents: MAX_TRACE_EVENTS,
} as const;
