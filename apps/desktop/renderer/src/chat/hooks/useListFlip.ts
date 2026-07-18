import { useLayoutEffect, useRef, type RefObject } from 'react';

const FLIP_EPSILON_PX = 1;

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 列表重排 FLIP：顺序变化时用 translateY 补间，避免会话行瞬间跳位。
 *
 * - First：上一帧缓存的布局 top
 * - Last：清掉进行中 transform 后测量的新 top
 * - Invert / Play：transition transform → 0
 *
 * 置顶拖拽进行中应传 enabled=false，避免与原生 drag 抢 transform。
 */
export function useListFlip(
  containerRef: RefObject<HTMLElement | null>,
  orderKey: string,
  options?: {
    enabled?: boolean;
    itemSelector?: string;
  },
): void {
  const enabled = options?.enabled ?? true;
  const itemSelector = options?.itemSelector ?? '[data-conversation-id]';
  const prevPositionsRef = useRef<Map<string, number>>(new Map());
  const prevOrderKeyRef = useRef(orderKey);
  const animatingRef = useRef<Set<HTMLElement>>(new Set());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clearInlineMotion = (node: HTMLElement) => {
      node.style.transition = 'none';
      node.style.transform = '';
      node.classList.remove('is-flipping');
    };

    // 重排后若仍残留上一轮 transform，先清掉再量 Last，否则 top 会偏。
    for (const node of animatingRef.current) {
      clearInlineMotion(node);
    }
    animatingRef.current.clear();

    const nodes = Array.from(container.querySelectorAll<HTMLElement>(itemSelector));
    // 强制一次布局，确保清 transform 后的 Last 准确。
    void container.offsetHeight;

    const nextPositions = new Map<string, number>();
    for (const node of nodes) {
      const id = node.dataset.conversationId;
      if (!id) continue;
      nextPositions.set(id, node.getBoundingClientRect().top);
    }

    const orderChanged = prevOrderKeyRef.current !== orderKey;
    const shouldAnimate =
      enabled &&
      orderChanged &&
      prevPositionsRef.current.size > 0 &&
      !prefersReducedMotion();

    if (shouldAnimate) {
      const playing: HTMLElement[] = [];

      for (const node of nodes) {
        const id = node.dataset.conversationId;
        if (!id) continue;
        const first = prevPositionsRef.current.get(id);
        const last = nextPositions.get(id);
        if (first == null || last == null) continue;
        const dy = first - last;
        if (Math.abs(dy) < FLIP_EPSILON_PX) continue;

        node.style.transition = 'none';
        node.style.transform = `translateY(${dy}px)`;
        node.classList.add('is-flipping');
        playing.push(node);
        animatingRef.current.add(node);
      }

      if (playing.length > 0) {
        void container.offsetHeight;

        requestAnimationFrame(() => {
          for (const node of playing) {
            // 交给 .is-flipping 的 CSS transition 播到 translateY(0)
            node.style.transition = '';
            node.style.transform = '';
          }
        });

        const onEnd = (event: TransitionEvent) => {
          if (event.propertyName && event.propertyName !== 'transform') return;
          const node = event.currentTarget as HTMLElement;
          node.classList.remove('is-flipping');
          node.style.transition = '';
          node.style.transform = '';
          animatingRef.current.delete(node);
          node.removeEventListener('transitionend', onEnd);
        };

        for (const node of playing) {
          node.addEventListener('transitionend', onEnd);
        }
      }
    }

    prevPositionsRef.current = nextPositions;
    prevOrderKeyRef.current = orderKey;
  }, [containerRef, enabled, itemSelector, orderKey]);
}
