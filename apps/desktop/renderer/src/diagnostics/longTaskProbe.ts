/**
 * rc.38 渲染进程采样大多停在等待帧，没有留下可命名的热点。
 * Long Task 只报告时长和浏览器给的 attribution 名，不读取 DOM 文本或计划正文。
 */

const MAX_FIELD = 120;
const FRAME_WINDOW_MS = 1000;
const FRAME_BUSY_MS = 24;
const FRAME_BUSY_COUNT = 3;
const FRAME_MAX_MS = 32;

/** 渲染进程本地时间。用来和主进程诊断、采样钟对齐。 */
export function diagnosticStamp(date = new Date()): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function attributionToken(value: string): string {
  const withoutQuery = value.split('?')[0]?.split('#')[0] ?? '';
  const base = withoutQuery.split(/[/\\]/).pop() || 'script';
  return base.replace(/['"`]/g, '').slice(0, 80);
}

export interface LongTaskAttribution {
  name?: string;
  containerName?: string;
}

export interface LongTaskEntry {
  duration: number;
  name?: string;
  attribution?: LongTaskAttribution[];
}

export function formatRendererLongTask(entry: LongTaskEntry, at = diagnosticStamp()): string {
  const via = (entry.attribution ?? [])
    .map((item) => [item.containerName, item.name]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .map(attributionToken)
      .join(':'))
    .filter(Boolean)
    .join(',')
    .slice(0, MAX_FIELD);
  const name = String(entry.name || 'longtask').slice(0, MAX_FIELD);
  return `[renderer-longtask] at=${at} ms=${Math.round(entry.duration)} name=${name}${via ? ` via=${via}` : ''}`;
}

export interface FrameGapSummary {
  readonly frames: number;
  readonly busy: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

/** 长任务阈值以下的连续掉帧。空闲的 16ms 垂直同步不记。 */
export function summarizeFrameGaps(gaps: readonly number[], {
  busyMs = FRAME_BUSY_MS,
  busyCount = FRAME_BUSY_COUNT,
  maxMs = FRAME_MAX_MS,
} = {}): FrameGapSummary | null {
  if (gaps.length === 0) return null;
  let max = 0;
  let busy = 0;
  let total = 0;
  for (const gap of gaps) {
    if (!Number.isFinite(gap) || gap < 0) continue;
    total += gap;
    if (gap > max) max = gap;
    if (gap >= busyMs) busy += 1;
  }
  if (busy < busyCount && max < maxMs) return null;
  return {
    frames: gaps.length,
    busy,
    maxMs: Math.round(max),
    meanMs: Math.round(total / gaps.length),
  };
}

export function formatRendererFrame(summary: FrameGapSummary, at = diagnosticStamp()): string {
  return `[renderer-frame] at=${at} windowMs=${FRAME_WINDOW_MS} frames=${summary.frames} busy=${summary.busy} max=${summary.maxMs} mean=${summary.meanMs}`;
}

export function observeRendererFrames(
  requestFrame: typeof requestAnimationFrame,
  log: (line: string) => void = (line) => console.info(line),
  now: () => number = () => performance.now(),
): { disconnect(): void } {
  if (typeof requestFrame !== 'function') return { disconnect() {} };
  let stopped = false;
  let last = now();
  let windowStart = last;
  let gaps: number[] = [];
  const frame = () => {
    if (stopped) return;
    const at = now();
    gaps.push(at - last);
    last = at;
    if (at - windowStart >= FRAME_WINDOW_MS) {
      const summary = summarizeFrameGaps(gaps);
      gaps = [];
      windowStart = at;
      if (summary) log(formatRendererFrame(summary));
    }
    requestFrame(frame);
  };
  requestFrame(frame);
  return { disconnect() { stopped = true; } };
}

export function observeRendererLongTasks(
  PerformanceObserverImpl: typeof PerformanceObserver,
  log: (line: string) => void = (line) => console.info(line),
): { disconnect(): void } {
  if (typeof PerformanceObserverImpl !== 'function') return { disconnect() {} };
  const observer = new PerformanceObserverImpl((list) => {
    for (const entry of list.getEntries()) log(formatRendererLongTask(entry as LongTaskEntry));
  });
  try {
    observer.observe({ entryTypes: ['longtask'] });
  } catch {
    return { disconnect() { observer.disconnect(); } };
  }
  return observer;
}
