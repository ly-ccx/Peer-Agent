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
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const rect = trigger.getBoundingClientRect();
      const width = panel.offsetWidth;
      openingHeight ??= panel.offsetHeight;
      const position = positionAnchoredOverlay(
        { left: rect.right - width, top: rect.top, bottom: rect.bottom },
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
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (triggerRef.current) observer?.observe(triggerRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, triggerRef, panelRef]);
  return style;
}
