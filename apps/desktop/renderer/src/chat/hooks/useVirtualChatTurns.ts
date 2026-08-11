import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createFrameCoalescer } from '../state/frameCoalescer';
import { IndexedResourceRegistry } from '../state/indexedResourceRegistry';
import {
  calculateVirtualTurnRange,
  DEFAULT_TURN_ESTIMATE_PX,
  DEFAULT_TURN_OVERSCAN_PX,
  estimateVirtualTurnOffset,
  type VirtualTurnRange,
} from '../state/virtualTurns';

interface UseVirtualChatTurnsOptions {
  readonly ownerKey: string | null;
  readonly count: number;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
}

export interface ScrollToTurnOptions {
  readonly align?: 'start' | 'center';
}

interface ViewportGeometry {
  scrollTop: number;
  clientHeight: number;
}

const EMPTY_RANGE: VirtualTurnRange = {
  items: [],
  totalSize: 0,
  paddingStart: 0,
  paddingEnd: 0,
  startIndex: 0,
  endIndex: -1,
};

function rangesEqual(left: VirtualTurnRange, right: VirtualTurnRange): boolean {
  if (
    left.startIndex !== right.startIndex
    || left.endIndex !== right.endIndex
    || left.paddingStart !== right.paddingStart
    || left.paddingEnd !== right.paddingEnd
    || left.totalSize !== right.totalSize
    || left.items.length !== right.items.length
  ) {
    return false;
  }
  for (let index = 0; index < left.items.length; index += 1) {
    const leftItem = left.items[index]!;
    const rightItem = right.items[index]!;
    if (
      leftItem.index !== rightItem.index
      || leftItem.start !== rightItem.start
      || leftItem.size !== rightItem.size
      || leftItem.end !== rightItem.end
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 无外部依赖的动态高度轮次虚拟化。
 *
 * 关键性能约束：
 * - 滚动几何（scrollTop / clientHeight）只放 ref，避免每帧 setState 唤醒整棵 ChatSurface。
 * - 仅当虚拟窗口索引 / padding / totalSize 真正变化时才 setState（rangeChanged）。
 * - 测量结果按 index 缓存；ResizeObserver 只观察当前窗口中的少量节点。
 */
export function useVirtualChatTurns({ ownerKey, count, scrollRef, enabled }: UseVirtualChatTurnsOptions) {
  const measuredSizesRef = useRef(new Map<number, number>());
  const observersRef = useRef(new IndexedResourceRegistry<HTMLElement, { dispose(): void }>());
  const forcedIndexReleaseRef = useRef(createFrameCoalescer({
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (frameId) => window.cancelAnimationFrame(frameId),
  }));
  const viewportRef = useRef<ViewportGeometry>({ scrollTop: 0, clientHeight: 0 });
  const forcedIndexRef = useRef<number | null>(null);
  const rangeRef = useRef<VirtualTurnRange>(EMPTY_RANGE);
  /** 帧内累计的 scrollTop 补偿量（见 measureElement），一帧只写一次 DOM。 */
  const pendingScrollCompensationRef = useRef(0);
  /** 测量结果的帧级汇聚：一帧内多个 turn 完成测量时只触发一次补偿 + 范围同步。 */
  const measurementFlushRef = useRef(createFrameCoalescer({
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (frameId) => window.cancelAnimationFrame(frameId),
  }));
  const [range, setRange] = useState<VirtualTurnRange>(EMPTY_RANGE);

  const computeRange = useCallback((forceIndex: number | null = forcedIndexRef.current): VirtualTurnRange => {
    if (count <= 0) {
      return EMPTY_RANGE;
    }
    return calculateVirtualTurnRange({
      count,
      scrollTop: viewportRef.current.scrollTop,
      viewportSize: viewportRef.current.clientHeight,
      measuredSizes: measuredSizesRef.current,
      estimateSize: DEFAULT_TURN_ESTIMATE_PX,
      // When virtualization is disabled, force the full range so all turns stay mounted.
      overscanPx: enabled ? DEFAULT_TURN_OVERSCAN_PX : Number.MAX_SAFE_INTEGER,
      forceIndex: enabled ? forceIndex : null,
    });
  }, [count, enabled]);

  const commitRangeIfChanged = useCallback((next: VirtualTurnRange): boolean => {
    // rangeChanged: only publish React state when the virtual window truly changes.
    const rangeChanged = !rangesEqual(rangeRef.current, next);
    if (!rangeChanged) return false;
    rangeRef.current = next;
    setRange(next);
    return true;
  }, []);

  const syncRange = useCallback((forceIndex: number | null = forcedIndexRef.current) => {
    commitRangeIfChanged(computeRange(forceIndex));
  }, [commitRangeIfChanged, computeRange]);
  const countRef = useRef(count);
  countRef.current = count;
  const syncRangeRef = useRef(syncRange);
  syncRangeRef.current = syncRange;
  const ownerKeyRef = useRef(ownerKey);

  const refreshMountedMeasurements = useCallback(() => {
    measuredSizesRef.current.clear();
    observersRef.current.forEach((element, index) => {
      if (index < 0 || index >= countRef.current) return;
      measuredSizesRef.current.set(
        index,
        Math.max(1, element.getBoundingClientRect().height),
      );
    });
  }, []);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const next: ViewportGeometry = {
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    };
    const previous = viewportRef.current;
    if (previous.scrollTop === next.scrollTop && previous.clientHeight === next.clientHeight) {
      return;
    }
    viewportRef.current = next;
    // Geometry lives in a ref; React only re-renders when the derived virtual range changes.
    syncRangeRef.current();
  }, [scrollRef]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    // Callback refs have already committed at this point. On an owner switch,
    // discard the previous conversation's index heights, but keep the observers
    // attached to the nodes that now belong to the new conversation. A destructive
    // reset here would leave those mounted nodes permanently unobserved until a
    // later message happened to remount the virtual window.
    if (ownerKeyRef.current !== ownerKey) {
      ownerKeyRef.current = ownerKey;
      forcedIndexReleaseRef.current.cancel();
      forcedIndexRef.current = null;
      refreshMountedMeasurements();
    }

    viewportRef.current = {
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    };
    syncRangeRef.current();
    const observer = new ResizeObserver(() => {
      const target = scrollRef.current;
      if (!target) return;
      viewportRef.current = {
        scrollTop: target.scrollTop,
        clientHeight: target.clientHeight,
      };
      syncRangeRef.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ownerKey, refreshMountedMeasurements, scrollRef]);

  useEffect(() => {
    for (const index of measuredSizesRef.current.keys()) {
      if (index >= count) measuredSizesRef.current.delete(index);
    }
    syncRange();
  }, [count, syncRange]);

  useEffect(() => () => {
    observersRef.current.clear();
    forcedIndexReleaseRef.current.cancel();
    measurementFlushRef.current.cancel();
    pendingScrollCompensationRef.current = 0;
  }, []);

  const measureElement = useCallback((
    index: number,
    element: HTMLElement | null,
    previousElement?: HTMLElement | null,
  ) => {
    if (!element) {
      if (previousElement) observersRef.current.release(index, previousElement);
      return;
    }

    const applyMeasurement = () => {
      const nextSize = Math.max(1, element.getBoundingClientRect().height);
      const previousSize = measuredSizesRef.current.get(index);
      if (previousSize != null && Math.abs(previousSize - nextSize) < 1) return;

      const scrollElement = scrollRef.current;
      const oldOffset = estimateVirtualTurnOffset(
        index,
        countRef.current,
        measuredSizesRef.current,
        DEFAULT_TURN_ESTIMATE_PX,
      );
      measuredSizesRef.current.set(index, nextSize);
      const isAboveViewport = scrollElement && oldOffset < scrollElement.scrollTop;
      if (isAboveViewport) {
        const oldSize = previousSize ?? DEFAULT_TURN_ESTIMATE_PX;
        // 累积到帧级一次性补偿：快滚时一帧会挂载/测量多个 turn，
        // 若每个都同步改 scrollTop，会与用户滚动惯性打架（表现为“回跳”），
        // 且每次测量都 setState 会让 React 在滚动中风暴式重渲染。
        pendingScrollCompensationRef.current += nextSize - oldSize;
      }
      measurementFlushRef.current.request(() => {
        const scrollNode = scrollRef.current;
        const compensation = pendingScrollCompensationRef.current;
        pendingScrollCompensationRef.current = 0;
        if (scrollNode && compensation !== 0) {
          scrollNode.scrollTop += compensation;
          viewportRef.current = {
            scrollTop: scrollNode.scrollTop,
            clientHeight: scrollNode.clientHeight,
          };
        }
        // Measurement changes may alter offsets/padding even when start/end stay put.
        syncRangeRef.current();
      });
      // 视口内/下方 turn（流式增长的那条）必须在本帧就把 spacer 同步到最新高度，
      // 否则贴底逻辑用的是上一帧的 totalSize，每帧都会“先窜上去再被拉回”。
      // 上方补偿仍走 rAF 合并，避免滚动惯性期间回跳。
      if (!isAboveViewport) {
        measurementFlushRef.current.flush();
      }
    };

    element.dataset.virtualTurnIndex = String(index);
    applyMeasurement();
    observersRef.current.replace(index, element, () => {
      const observer = new ResizeObserver(applyMeasurement);
      observer.observe(element);
      return { dispose: () => observer.disconnect() };
    });
  }, [scrollRef]);

  const scrollToTurn = useCallback((index: number, options: ScrollToTurnOptions = {}) => {
    const currentCount = countRef.current;
    if (index < 0 || index >= currentCount) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    forcedIndexRef.current = index;
    const offset = estimateVirtualTurnOffset(
      index,
      currentCount,
      measuredSizesRef.current,
      DEFAULT_TURN_ESTIMATE_PX,
    );
    const measuredSize = measuredSizesRef.current.get(index) ?? DEFAULT_TURN_ESTIMATE_PX;
    const top = options.align === 'center'
      ? offset - Math.max(0, (scrollElement.clientHeight - measuredSize) / 2)
      : offset;
    scrollElement.scrollTop = Math.max(0, top);
    viewportRef.current = {
      scrollTop: scrollElement.scrollTop,
      clientHeight: scrollElement.clientHeight,
    };
    syncRange(index);

    // A later navigation replaces this release frame. Reset/unmount cancels it,
    // so a stale conversation can never publish a range into the new owner.
    forcedIndexReleaseRef.current.request(() => {
      forcedIndexRef.current = null;
      syncRangeRef.current(null);
    });
  }, [scrollRef]);

  /**
   * Rebuild the height model without detaching observers from mounted turns.
   * Used after a structural message rewrite (for example compaction). Observer
   * ownership only ends when a turn ref releases its exact element or the hook
   * unmounts; otherwise mounted nodes could remain permanently unobserved.
   */
  const resetMeasurements = useCallback(() => {
    forcedIndexReleaseRef.current.cancel();
    forcedIndexRef.current = null;
    refreshMountedMeasurements();

    const element = scrollRef.current;
    if (element) {
      viewportRef.current = {
        scrollTop: element.scrollTop,
        clientHeight: element.clientHeight,
      };
    }
    syncRangeRef.current();
  }, [refreshMountedMeasurements, scrollRef]);

  return {
    range,
    measureElement,
    scrollToTurn,
    updateViewport,
    resetMeasurements,
  };
}
