import type { CSSProperties } from 'react';

type Rect = { left: number; top: number; width: number; height: number };

/** Target geometry belongs to presentation; it never changes the action being dismissed. */
export function overlayCloseTarget(source: Rect, target: Rect): CSSProperties | undefined {
  if (![source.left, source.top, source.width, source.height, target.left, target.top, target.width, target.height].every(Number.isFinite)
    || source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) return undefined;
  return {
    '--motion-target-x': `${target.left - source.left}px`,
    '--motion-target-y': `${target.top - source.top}px`,
    '--motion-target-scale-x': target.width / source.width,
    '--motion-target-scale-y': target.height / source.height,
  } as CSSProperties;
}
