import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  packWorkStreamColumns,
  shouldPackWorkStream,
  workStreamColumnCount,
  workStreamItemWeight,
} from './workStreamLayout';

export function WorkStream<T = TaskOverviewItem>({
  items,
  children,
  weightOf,
  className,
}: {
  readonly items: readonly T[];
  readonly children: (item: T) => ReactNode;
  readonly weightOf?: (item: T) => number;
  readonly className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState<1 | 2>(1);
  const resolveWeight = weightOf ?? (workStreamItemWeight as (item: T) => number);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const remPx = Number.parseFloat(getComputedStyle(node).fontSize) || 16;
    const update = (width: number) => {
      setColumnCount(workStreamColumnCount(width, remPx));
    };
    update(node.clientWidth);
    const observer = new ResizeObserver((entries) => {
      update(entries[0]?.contentRect.width ?? node.clientWidth);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const packed = shouldPackWorkStream(items.length, columnCount);
  const streamClassName = ['task-overview-work-stream', className, packed ? 'is-waterfall' : '']
    .filter(Boolean)
    .join(' ');

  if (!packed) {
    return (
      <div ref={ref} className={streamClassName}>
        {items.map((item) => children(item))}
      </div>
    );
  }

  const columns = packWorkStreamColumns(items, columnCount, resolveWeight);
  return (
    <div ref={ref} className={streamClassName}>
      {columns.map((column, index) => (
        <div key={index} className="task-overview-work-stream__column">
          {column.map((item) => children(item))}
        </div>
      ))}
    </div>
  );
}
