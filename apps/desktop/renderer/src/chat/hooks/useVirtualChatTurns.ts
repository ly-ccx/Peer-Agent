import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  calculateVirtualTurnRange,
  DEFAULT_TURN_ESTIMATE_PX,
  DEFAULT_TURN_OVERSCAN_PX,
  estimateVirtualTurnOffset,
  type VirtualTurnRange,
} from '../state/virtualTurns';

interface UseVirtualChatTurnsOptions {
  readonly count: number;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
}

interface ScrollToTurnOptions {
  readonly align?: 'start' | 'center';
}

interface ViewportSnapshot {
  scrollTop: number;
  clientHeight: number;
}

interface RangeSignature {
  startIndex: number;
  endIndex: number;
  totalSize: number;
  paddingStart: number;
  paddingEnd: number;
  forceIndex: number | null;
  enabled: boolean;
  count: number;
}

function rangeSignature(range: VirtualTurnRange, forceIndex: number | null, enabled: boolean, count: number): RangeSignature {
  return {
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    totalSize: range.totalSize,
    paddingStart: range.paddingStart,
    paddingEnd: range.paddingEnd,
    forceIndex,
    enabled,
    count,
  };
}

function sameRangeSignature(a: RangeSignature | null, b: RangeSignature): boolean {
  if (!a) return false;
  return a.startIndex === b.startIndex
    && a.endIndex === b.endIndex
    && a.totalSize === b.totalSize
    && a.paddingStart === b.paddingStart
    && a.paddingEnd === b.paddingEnd
    && a.forceIndex === b.forceIndex
    && a.enabled === b.enabled
    && a.count === b.count;
}

/**
 * 无外部依赖的动态高度轮次虚拟化。
 *
 * 性能契约：
 * - scrollTop 只写 ref，不直接进 React state；只有虚拟窗口 / padding / totalSize
 *   真正变化时才 setState，避免滚动每帧重绘整棵 ChatSurface。
 * - ResizeObserver 测高合并到 rAF 一次 flush，减少“测高 → 改 scrollTop → 再渲染”抖动。
 */
export function useVirtualChatTurns({ count, scrollRef, enabled }: UseVirtualChatTurnsOptions) {
  const measuredSizesRef = useRef(new Map<number, number>());
  const observersRef = useRef(new Map<Element, ResizeObserver>());
  const viewportRef = useRef<ViewportSnapshot>({ scrollTop: 0, clientHeight: 0 });
  const forcedIndexRef = useRef<number | null>(null);
  const signatureRef = useRef<RangeSignature | null>(null);
  const measureFlushFrameRef = useRef<number | null>(null);
  const pendingScrollAdjustRef = useRef(0);
  const [range, setRange] = useState<VirtualTurnRange>(() => calculateVirtualTurnRange({
    count: 0,
    scrollTop: 0,
    viewportSize: 0,
    measuredSizes: new Map(),
    estimateSize: DEFAULT_TURN_ESTIMATE_PX,
    // 未启用虚拟化时 overscan 拉满，等价于渲染全部轮次。
    overscanPx: Number.MAX_SAFE_INTEGER,
  }));

  const publishRange = useCallback((nextForcedIndex: number | null = forcedIndexRef.current) => {
    const viewport = viewportRef.current;
    const nextRange = calculateVirtualTurnRange({
      count,
      scrollTop: viewport.scrollTop,
      viewportSize: viewport.clientHeight,
      measuredSizes: measuredSizesRef.current,
      estimateSize: DEFAULT_TURN_ESTIMATE_PX,
      // 关闭虚拟化时用无限 overscan 渲染全部，而不是另开一条渲染路径。
      overscanPx: enabled ? DEFAULT_TURN_OVERSCAN_PX : Number.MAX_SAFE_INTEGER,
      forceIndex: nextForcedIndex,
    });
    const nextSignature = rangeSignature(nextRange, nextForcedIndex, enabled, count);
    if (sameRangeSignature(signatureRef.current, nextSignature)) {
      return false;
    }
    signatureRef.current = nextSignature;
    forcedIndexRef.current = nextForcedIndex;
    setRange(nextRange);
    return true;
  }, [count, enabled]);

  const syncViewportFromDom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return false;
    const next = { scrollTop: element.scrollTop, clientHeight: element.clientHeight };
    const previous = viewportRef.current;
    if (previous.scrollTop === next.scrollTop && previous.clientHeight === next.clientHeight) {
      return false;
    }
    viewportRef.current = next;
    return true;
  }, [scrollRef]);

  const updateViewport = useCallback(() => {
    const changed = syncViewportFromDom();
    if (!changed && signatureRef.current) {
      // DOM 几何没变时仍可能因测高缓存更新需要发布；调用方在测高路径会强制 publish。
      return;
    }
    publishRange();
  }, [publishRange, syncViewportFromDom]);

  const flushMeasurements = useCallback(() => {
    measureFlushFrameRef.current = null;
    const scrollElement = scrollRef.current;
    if (scrollElement && pendingScrollAdjustRef.current !== 0) {
      scrollElement.scrollTop += pendingScrollAdjustRef.current;
      pendingScrollAdjustRef.current = 0;
      syncViewportFromDom();
    }
    publishRange();
  }, [publishRange, scrollRef, syncViewportFromDom]);

  const scheduleMeasurementFlush = useCallback(() => {
    if (measureFlushFrameRef.current != null) return;
    measureFlushFrameRef.current = requestAnimationFrame(() => {
      flushMeasurements();
    });
  }, [flushMeasurements]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    syncViewportFromDom();
    publishRange();
    const observer = new ResizeObserver(() => {
      if (syncViewportFromDom()) {
        publishRange();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [publishRange, scrollRef, syncViewportFromDom]);

  useEffect(() => {
    for (const index of measuredSizesRef.current.keys()) {
      if (index >= count) measuredSizesRef.current.delete(index);
    }
    // count 变化后窗口边界与 totalSize 必变
    publishRange();
  }, [count, publishRange]);

  useEffect(() => () => {
    observersRef.current.forEach((observer) => observer.disconnect());
    observersRef.current.clear();
    if (measureFlushFrameRef.current != null) {
      cancelAnimationFrame(measureFlushFrameRef.current);
      measureFlushFrameRef.current = null;
    }
  }, []);

  const measureElement = useCallback((index: number, element: HTMLElement | null) => {
    for (const [observedElement, observer] of observersRef.current) {
      if (observedElement instanceof HTMLElement && observedElement.dataset.virtualTurnIndex === String(index)) {
        observer.disconnect();
        observersRef.current.delete(observedElement);
      }
    }
    if (!element) return;

    const applyMeasurement = () => {
      const nextSize = Math.max(1, element.getBoundingClientRect().height);
      const previousSize = measuredSizesRef.current.get(index);
      if (previousSize != null && Math.abs(previousSize - nextSize) < 1) return;

      const oldOffset = estimateVirtualTurnOffset(
        index,
        count,
        measuredSizesRef.current,
        DEFAULT_TURN_ESTIMATE_PX,
      );
      measuredSizesRef.current.set(index, nextSize);

      // 视口上方条目高度变化时，累计 scrollTop 修正，避免内容跳动；合并到 rAF 一次写入。
      const scrollTop = viewportRef.current.scrollTop;
      if (oldOffset < scrollTop) {
        const oldSize = previousSize ?? DEFAULT_TURN_ESTIMATE_PX;
        pendingScrollAdjustRef.current += nextSize - oldSize;
      }
      scheduleMeasurementFlush();
    };

    element.dataset.virtualTurnIndex = String(index);
    applyMeasurement();
    const observer = new ResizeObserver(applyMeasurement);
    observer.observe(element);
    observersRef.current.set(element, observer);
  }, [count, scheduleMeasurementFlush]);

  const scrollToTurn = useCallback((index: number, options: ScrollToTurnOptions = {}) => {
    if (index < 0 || index >= count) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    forcedIndexRef.current = index;
    const offset = estimateVirtualTurnOffset(
      index,
      count,
      measuredSizesRef.current,
      DEFAULT_TURN_ESTIMATE_PX,
    );
    const size = measuredSizesRef.current.get(index) ?? DEFAULT_TURN_ESTIMATE_PX;
    const top = options.align === 'center'
      ? Math.max(0, offset - (scrollElement.clientHeight - size) / 2)
      : offset;
    scrollElement.scrollTop = top;
    viewportRef.current = {
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight,
    };
    publishRange(index);

    // 强制索引只服务一次定位，下一帧恢复按 scrollTop 计算，避免窗口被钉死。
    requestAnimationFrame(() => {
      if (forcedIndexRef.current === index) {
        forcedIndexRef.current = null;
        publishRange(null);
      }
    });
  }, [count, publishRange, scrollRef]);

  const resetMeasurements = useCallback(() => {
    measuredSizesRef.current.clear();
    pendingScrollAdjustRef.current = 0;
    for (const observer of observersRef.current.values()) {
      observer.disconnect();
    }
    observersRef.current.clear();
    // 重新扫描当前 DOM 中仍挂着的 turn 节点
    const scrollElement = scrollRef.current;
    if (scrollElement) {
      const nodes = scrollElement.querySelectorAll<HTMLElement>('[data-virtual-turn-index]');
      for (const element of nodes) {
        const index = Number(element.dataset.virtualTurnIndex);
        if (!Number.isInteger(index) || index < 0 || index >= count) continue;
        measuredSizesRef.current.set(index, Math.max(1, element.offsetHeight));
      }
    }
    syncViewportFromDom();
    publishRange();
  }, [count, publishRange, scrollRef, syncViewportFromDom]);

  return {
    range,
    measureElement,
    scrollToTurn,
    updateViewport,
    resetMeasurements,
  };
}
