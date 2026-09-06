export interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
}

/** Viewport coordinates; the panel remains reachable even when the anchor is offscreen. */
export function positionAnchoredOverlay(
  anchor: OverlayRect,
  panel: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
) {
  const margin = 12;
  const gap = 8;
  const maxWidth = Math.max(0, viewport.width - margin * 2);
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const width = Math.min(panel.width, maxWidth);
  const height = Math.min(panel.height, maxHeight);
  const above = anchor.top - gap - height;
  const preferredTop = above >= margin ? above : anchor.bottom + gap;
  return {
    left: Math.max(margin, Math.min(anchor.left, viewport.width - margin - width)),
    top: Math.max(margin, Math.min(preferredTop, viewport.height - margin - height)),
    maxWidth,
    maxHeight,
  };
}
