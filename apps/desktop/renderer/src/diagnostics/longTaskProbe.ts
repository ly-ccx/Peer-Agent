/**
 * rc.38 渲染进程采样大多停在等待帧，没有留下可命名的热点。
 * Long Task 只报告时长和浏览器给的 attribution 名，不读取 DOM 文本或计划正文。
 */

const MAX_FIELD = 120;

export interface LongTaskAttribution {
  name?: string;
  containerName?: string;
}

export interface LongTaskEntry {
  duration: number;
  name?: string;
  attribution?: LongTaskAttribution[];
}

export function formatRendererLongTask(entry: LongTaskEntry): string {
  const via = (entry.attribution ?? [])
    .map((item) => [item.containerName, item.name].filter((part) => typeof part === 'string' && part).join(':'))
    .filter(Boolean)
    .join(',')
    .slice(0, MAX_FIELD);
  const name = String(entry.name || 'longtask').slice(0, MAX_FIELD);
  return `[renderer-longtask] ms=${Math.round(entry.duration)} name=${name}${via ? ` via=${via}` : ''}`;
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
