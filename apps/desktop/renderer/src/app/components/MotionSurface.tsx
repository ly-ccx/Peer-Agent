import { cloneElement, useCallback, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactElement, type Ref } from 'react';
import { watchVisualMotion } from '../state/visualMotion';
import { useMotionSettled } from '../hooks/useMotionSettled';

type SurfaceProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };

/**
 * One host DOM element, with no extra layout node. Retain its last committed
 * content only for visual exit. Owners close their
 * interaction layer and dispatch actions immediately; this adds no layout node.
 */
export function MotionSurface({ children, kind = 'rise' }: {
  readonly children: ReactElement | null | false | undefined;
  readonly kind?: 'rise' | 'fade';
}) {
  const visible = Boolean(children);
  const previous = useRef<ReactElement | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const [retained, setRetained] = useState(visible);
  useLayoutEffect(() => { if (children) previous.current = children; }, [children]);
  const child = (children || previous.current) as ReactElement<SurfaceProps> | null;
  const entryIdentity = useMemo(() => ({}), [child?.type, child?.key]);
  const settled = useMotionSettled(root, visible, entryIdentity);
  const targetRef = child?.props.ref;
  const mergedRef = useCallback((node: HTMLElement | null) => {
    const previousNode = root.current;
    root.current = node;
    if (typeof targetRef === 'function') {
      const cleanup = targetRef(node);
      if (typeof cleanup === 'function') return () => { root.current = null; cleanup(); };
    } else if (targetRef && (node || targetRef.current === previousNode)) targetRef.current = node;
  }, [targetRef]);

  useLayoutEffect(() => {
    if (visible) { setRetained(true); return; }
    if (!retained) return;
    let animations: Animation[] = [];
    try { animations = root.current?.getAnimations?.() ?? []; } catch { /* Static exit. */ }
    const motion = watchVisualMotion(animations, () => {
      previous.current = null;
      setRetained(false);
    });
    return motion.cancel;
  }, [visible, retained]);

  if (!child || !visible && !retained) return null;
  return cloneElement(child, {
    ref: mergedRef,
    className: `${child.props.className ?? ''} motion-surface`,
    'data-surface-state': visible ? 'open' : 'closed',
    'data-surface-kind': kind,
    'data-surface-settled': settled,
    inert: !visible || child.props.inert,
    'aria-hidden': !visible || child.props['aria-hidden'],
  } as SurfaceProps);
}
