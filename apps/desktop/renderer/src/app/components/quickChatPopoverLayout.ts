import type {
  QuickChatPopoverAnchorRect,
  QuickChatPopoverState,
} from '../../preload/contracts/bootstrapPreloadApi.ts';

export const POPOVER_MAX_SIZE = Object.freeze({ width: 360, height: 280 });
/** Flush under the Quick bar bottom (no floating air gap / double seam). */
export const POPOVER_GAP = 0;
const VIEWPORT_INSET = 8;
/** Model / effort hang from the right edge of their trigger. */
export const RIGHT_ALIGNED_KINDS = new Set(['model', 'effort'] as const);

/**
 * Compact popover size from menu content (not the full input bar width).
 */
export function resolveQuickChatPopoverVisualSize(state: QuickChatPopoverState & {
  readonly anchorRect?: QuickChatPopoverAnchorRect | null;
}) {
  const hasDetails = state.items.some((item) => typeof item.detail === 'string' && item.detail.length > 0);
  const longestText = state.items.reduce((length, item) => Math.max(
    length,
    item.label.length,
    item.detail?.length ?? 0,
  ), 0);
  const rowHeight = hasDetails ? 44 : 34;
  const minWidth = state.kind === 'workspace' ? 280 : state.kind === 'effort' ? 240 : 190;
  const width = state.kind === 'effort'
    ? 240
    : Math.min(
      POPOVER_MAX_SIZE.width,
      Math.max(minWidth, 80 + longestText * (hasDetails ? 6.2 : 7.2)),
    );
  const height = state.kind === 'effort'
    ? 72
    : Math.min(POPOVER_MAX_SIZE.height, 12 + Math.max(1, state.items.length) * rowHeight);
  return { width: Math.round(width), height: Math.round(height) };
}

/**
 * Align the compact menu to the trigger:
 * - model / effort: right edges match the trigger
 * - workspace / mode: left edges match the trigger
 * Vertical: flush under the bar bottom when containerRect is provided.
 */
export function resolveQuickChatPopoverPosition({
  kind,
  anchorRect,
  containerRect,
  size,
  viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 720,
}: {
  readonly kind?: QuickChatPopoverState['kind'];
  /** Trigger button rect (horizontal alignment). */
  readonly anchorRect?: QuickChatPopoverAnchorRect | null;
  /** Input bar rect (vertical flush under bar bottom). */
  readonly containerRect?: QuickChatPopoverAnchorRect | null;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewportWidth?: number;
}) {
  if (!anchorRect) {
    return { left: VIEWPORT_INSET, top: 0 };
  }

  const preferRight = kind != null && RIGHT_ALIGNED_KINDS.has(kind as 'model' | 'effort');
  const unclampedLeft = preferRight
    ? Math.round(anchorRect.x + anchorRect.width - size.width)
    : Math.round(anchorRect.x);
  const maxLeft = Math.max(VIEWPORT_INSET, Math.round(viewportWidth - size.width - VIEWPORT_INSET));
  const left = Math.min(maxLeft, Math.max(VIEWPORT_INSET, unclampedLeft));

  // Prefer bar bottom so the compact menu sits flush under the whole input bar.
  const verticalAnchor = containerRect ?? anchorRect;
  const top = Math.round(verticalAnchor.y + verticalAnchor.height) + POPOVER_GAP;
  return { left, top };
}
