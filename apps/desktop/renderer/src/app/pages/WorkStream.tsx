import type { TaskOverviewItem } from '@peer-agent/protocol';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  packWorkStreamColumns,
  shouldPackWorkStream,
  workStreamColumnCount,
  workStreamItemWeight,
} from './workStreamLayout';

/** FLIP 重排时长与缓动：与 particle-shatter 退场塌缩（280ms）同族，归位稍慢半拍。 */
const FLIP_MS = 320;
const FLIP_EASING = 'cubic-bezier(0.33, 0, 0.2, 1)';

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

type FlipEntry = { top: number; left: number; el: HTMLElement };
type FlipOffsets = Map<string, FlipEntry>;

export function WorkStream<T = TaskOverviewItem>({
  items,
  children,
  weightOf,
  keyOf,
  className,
}: {
  readonly items: readonly T[];
  readonly children: (item: T) => ReactNode;
  readonly weightOf?: (item: T) => number;
  /** 稳定 key：FLIP 靠它把「移动前后的同一张卡」配对，须与 children 的 React key 一致。 */
  readonly keyOf?: (item: T) => string;
  readonly className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState<1 | 2>(1);
  const resolveWeight = weightOf ?? (workStreamItemWeight as (item: T) => number);
  const resolveKey = keyOf ?? ((item: T) => (item as TaskOverviewItem).taskId);
  const offsetsRef = useRef<FlipOffsets | null>(null);
  const widthRef = useRef(0);
  const rafRef = useRef(0);

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

  const columns = packed ? packWorkStreamColumns(items, columnCount, resolveWeight) : null;

  /**
   * FLIP 重排：卡片换位（跨列补位 / 列数变化）时先按旧位置反向平移，再归零成
   * 平移动画。位置用 offsetTop/offsetLeft 测（不受 transform 影响）；新旧卡按
   * key 配对 —— React 跨列搬移会销毁重建 DOM 节点，元素身份不可靠，key 才是
   * 「同一张卡」的稳定真源。渲染结构已知：列的第 i 个子元素就是 columns[c][i]。
   */
  const measureOffsets = (node: HTMLElement): FlipOffsets => {
    const offsets: FlipOffsets = new Map();
    if (columns) {
      const columnNodes = node.querySelectorAll<HTMLElement>(':scope > *');
      columns.forEach((column, columnIndex) => {
        const columnNode = columnNodes[columnIndex];
        if (!columnNode) return;
        const kids = columnNode.children;
        column.forEach((item, itemIndex) => {
          const el = kids[itemIndex];
          if (el instanceof HTMLElement) {
            offsets.set(resolveKey(item), { top: el.offsetTop, left: el.offsetLeft, el });
          }
        });
      });
    } else {
      const kids = node.children;
      items.forEach((item, index) => {
        const el = kids[index];
        if (el instanceof HTMLElement) {
          offsets.set(resolveKey(item), { top: el.offsetTop, left: el.offsetLeft, el });
        }
      });
    }
    return offsets;
  };

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const prev = offsetsRef.current;
    // 退场塌缩进行中：宿主 max-height 过渡本身在推动同列卡片平滑上移，
    // 此刻的位移已由布局动画覆盖，再叠 FLIP 会双重补偿。
    const collapseInProgress = node.querySelector('.is-exiting') !== null;
    // 容器宽度变了（拖侧栏 / 缩窗口）：换列 / 重排是尺寸跟随，不是卡片补位，
    // 直接跳过 FLIP，只更新快照，避免卡片在拖拽中滞后跟手。
    const widthChanged = widthRef.current !== 0 && widthRef.current !== node.clientWidth;
    widthRef.current = node.clientWidth;
    if (prev && !collapseInProgress && !widthChanged && !prefersReducedMotion()) {
      const current = measureOffsets(node);
      for (const [key, after] of current) {
        const before = prev.get(key);
        if (!before) continue;
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        after.el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'translate(0, 0)' },
          ],
          { duration: FLIP_MS, easing: FLIP_EASING },
        );
      }
    }
    offsetsRef.current = measureOffsets(node);
    if (collapseInProgress && !prefersReducedMotion()) {
      // 塌缩期间宿主高度逐帧在变，快照要跟着刷新；否则移除瞬间会拿塌缩前的
      // 旧位置做反向补偿，出现「先跳回再滑一次」的双重动画。
      const tick = () => {
        const current = ref.current;
        if (!current || current.querySelector('.is-exiting') === null) return;
        offsetsRef.current = measureOffsets(current);
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(rafRef.current);
  });

  if (!columns) {
    return (
      <div ref={ref} className={streamClassName}>
        {items.map((item) => children(item))}
      </div>
    );
  }

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
