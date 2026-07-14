import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  calculateVirtualTurnRange,
  DEFAULT_TURN_ESTIMATE_PX,
  DEFAULT_TURN_OVERSCAN_PX,
  estimateVirtualTurnOffset,
} from '../state/virtualTurns';

interface UseVirtualChatTurnsOptions {
  readonly count: number;
  readonly scrollRef: React.RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
}

interface ScrollToTurnOptions {
  readonly align?: 'start' | 'center';
}

/**
 * 无外部依赖的动态高度轮次虚拟化。测量结果按 index 缓存；轮次数变化时保留已有高度，
 * 新轮次先用估算值。ResizeObserver 只观察当前窗口中的少量节点。
 */
export function useVirtualChatTurns({ count, scrollRef, enabled }: UseVirtualChatTurnsOptions) {
  const measuredSizesRef = useRef(new Map<number, number>());
  const observersRef = useRef(new Map<Element, ResizeObserver>());
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: 0 });
  const [forcedIndex, setForcedIndex] = useState<number | null>(null);

  const updateViewport = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setViewport((previous) => {
      const next = { scrollTop: element.scrollTop, clientHeight: element.clientHeight };
      return previous.scrollTop === next.scrollTop && previous.clientHeight === next.clientHeight
        ? previous
        : next;
    });
  }, [scrollRef]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    updateViewport();
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef, updateViewport]);

  useEffect(() => {
    for (const index of measuredSizesRef.current.keys()) {
      if (index >= count) measuredSizesRef.current.delete(index);
    }
  }, [count]);

  useEffect(() => () => {
    observersRef.current.forEach((observer) => observer.disconnect());
    observersRef.current.clear();
  }, []);

  const range = useMemo(
    () => calculateVirtualTurnRange({
      count,
      scrollTop: viewport.scrollTop,
      viewportSize: viewport.clientHeight,
      measuredSizes: measuredSizesRef.current,
      estimateSize: DEFAULT_TURN_ESTIMATE_PX,
      overscanPx: enabled ? DEFAULT_TURN_OVERSCAN_PX : Number.MAX_SAFE_INTEGER,
      forceIndex: forcedIndex,
    }),
    [count, enabled, forcedIndex, revision, viewport.clientHeight, viewport.scrollTop],
  );

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

      const scrollElement = scrollRef.current;
      const oldOffset = estimateVirtualTurnOffset(
        index,
        count,
        measuredSizesRef.current,
        DEFAULT_TURN_ESTIMATE_PX,
      );
      measuredSizesRef.current.set(index, nextSize);
      if (scrollElement && oldOffset < scrollElement.scrollTop) {
        const oldSize = previousSize ?? DEFAULT_TURN_ESTIMATE_PX;
        scrollElement.scrollTop += nextSize - oldSize;
      }
      setRevision((value) => value + 1);
    };

    element.dataset.virtualTurnIndex = String(index);
    applyMeasurement();
    const observer = new ResizeObserver(applyMeasurement);
    observer.observe(element);
    observersRef.current.set(element, observer);
  }, [count, scrollRef]);

  const scrollToTurn = useCallback((index: number, options: ScrollToTurnOptions = {}) => {
    if (index < 0 || index >= count) return;
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;

    setForcedIndex(index);
    const offset = estimateVirtualTurnOffset(
      index,
      count,
      measuredSizesRef.current,
      DEFAULT_TURN_ESTIMATE_PX,
    );
    const measuredSize = measuredSizesRef.current.get(index) ?? DEFAULT_TURN_ESTIMATE_PX;
    const top = options.align === 'center'
      ? offset - Math.max(0, (scrollElement.clientHeight - measuredSize) / 2)
      : offset;
    scrollElement.scrollTop = Math.max(0, top);
    updateViewport();

    window.requestAnimationFrame(() => setForcedIndex(null));
  }, [count, scrollRef, updateViewport]);

  const resetMeasurements = useCallback(() => {
    measuredSizesRef.current.clear();
    for (const element of observersRef.current.keys()) {
      if (!(element instanceof HTMLElement)) continue;
      const index = Number(element.dataset.virtualTurnIndex);
      if (!Number.isInteger(index) || index < 0 || index >= count) continue;
      measuredSizesRef.current.set(index, Math.max(1, element.offsetHeight));
    }
    setRevision((value) => value + 1);
    updateViewport();
  }, [count, updateViewport]);

  return {
    range,
    measureElement,
    scrollToTurn,
    updateViewport,
    resetMeasurements,
  };
}
