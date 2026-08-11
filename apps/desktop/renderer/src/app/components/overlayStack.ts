export const OVERLAY_SELECTOR = '[data-peer-overlay="true"]';

/**
 * Portalled overlays are appended to document.body in visual stacking order.
 * The last mounted overlay is therefore the only one allowed to consume Escape.
 */
export function isTopmostOverlay(
  overlay: Element | null,
  overlays: readonly Element[],
): boolean {
  return overlay !== null && overlays.at(-1) === overlay;
}
