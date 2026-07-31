import type {
  QuickChatPopoverAnchorRect,
  QuickChatPopoverState,
} from '../../preload/contracts/bootstrapPreloadApi.ts';

export const POPOVER_MAX_SIZE = Object.freeze({ width: 360, height: 360 });
/** Flush under the Quick bar bottom (no floating air gap / double seam). */
export const POPOVER_GAP = 0;
const VIEWPORT_INSET = 8;
/** Panel padding 6+6 + shell border 1+1 — keep in sync with quick-chat.css / main. */
const POPOVER_CHROME_HEIGHT = 14;
/** Model / effort hang from the right edge of their trigger. */
export const RIGHT_ALIGNED_KINDS = new Set(['model', 'effort'] as const);

/**
 * Compact popover size from menu content (not the full input bar width).
 * Keep in sync with apps/desktop/electron/main/quick-chat-window.mjs.
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
  const rowHeight = state.kind === 'access'
    ? 58
    : hasDetails
      ? 52
      : 36;
  const minWidth = state.kind === 'workspace'
    ? 300
    : state.kind === 'effort'
      ? 240
      : state.kind === 'access'
        ? 280
        : 190;
  const width = state.kind === 'effort'
    ? 240
    : Math.min(
      POPOVER_MAX_SIZE.width,
      Math.max(minWidth, 80 + longestText * (hasDetails ? 6.2 : 7.2)),
    );
  // Keep in sync with main resolveQuickChatPopoverSize — tight, not airy.
  const height = state.kind === 'effort'
    ? 84
    : Math.min(
      POPOVER_MAX_SIZE.height,
      POPOVER_CHROME_HEIGHT + Math.max(1, state.items.length) * rowHeight,
    );
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
