import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { positionAnchoredOverlay } from '../../../app/components/anchoredOverlay';

type ModelSelectionStyle = CSSProperties & {
  '--model-selection-open-height': string;
  '--model-selection-available-height': string;
};

/** Content changes keep the opening geometry; moving the anchor or viewport can reposition it. */
export function useModelSelectionPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
) {
  const [style, setStyle] = useState<ModelSelectionStyle>();
  useLayoutEffect(() => {
    if (!open) { setStyle(undefined); return; }
    let openingHeight: number | null = null;
    let openingAnchor: Pick<DOMRect, 'right' | 'top' | 'bottom'> | null = null;
    const updatePosition = (reanchor = false) => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      // A different model label or save indicator can resize the trigger. Only
      // vertical movement, scrolling or viewport changes move an already-open menu.
      if (!openingAnchor || reanchor || rect.top !== openingAnchor.top || rect.bottom !== openingAnchor.bottom) {
        openingAnchor = { right: rect.right, top: rect.top, bottom: rect.bottom };
      }
      const width = panel.offsetWidth;
      openingHeight ??= panel.offsetHeight;
      const position = positionAnchoredOverlay(
        { left: openingAnchor.right - width,
          top: openingAnchor.top, bottom: openingAnchor.bottom },
        { width, height: openingHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      const next: ModelSelectionStyle = {
        left: position.left,
        top: position.top,
        visibility: 'visible',
        '--model-selection-open-height': `${openingHeight}px`,
        '--model-selection-available-height': `calc(100vh - ${position.top}px - var(--space-3))`,
      };
      setStyle(current => current?.left === next.left && current?.top === next.top
        && current?.['--model-selection-open-height'] === next['--model-selection-open-height']
        ? current : next);
    };
    updatePosition();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => updatePosition());
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    const reanchor = () => updatePosition(true);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return;
      reanchor();
    };
    window.addEventListener('resize', reanchor);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reanchor);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, triggerRef, panelRef]);
  return style;
}
