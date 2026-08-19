export interface PreviewRect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface PreviewSize {
  readonly width: number;
  readonly height: number;
}

export interface PreviewViewport {
  readonly width: number;
  readonly height: number;
}

export interface PreviewPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: 'above' | 'below';
}

export const VIEWPORT_MARGIN = 12;
const TRIGGER_GAP = 8;

function clamp(value: number, min: number, max: number) {
  if (min > max) return min;
  return Math.min(max, Math.max(min, value));
}

export function availablePreviewSize(viewport: PreviewViewport): PreviewSize {
  return {
    width: Math.max(1, viewport.width - VIEWPORT_MARGIN * 2),
    height: Math.max(1, viewport.height - VIEWPORT_MARGIN * 2),
  };
}

export function fitPreviewToViewport(preview: PreviewSize, viewport: PreviewViewport): PreviewSize {
  const available = availablePreviewSize(viewport);
  return {
    width: Math.min(preview.width, available.width),
    height: Math.min(preview.height, available.height),
  };
}

export function positionTaskArtifactPreview(
  trigger: PreviewRect,
  preview: PreviewSize,
  viewport: PreviewViewport,
): PreviewPosition {
  const fitted = fitPreviewToViewport(preview, viewport);
  const maxLeft = viewport.width - VIEWPORT_MARGIN - fitted.width;
  const left = clamp(trigger.left, VIEWPORT_MARGIN, maxLeft);
  const spaceAbove = trigger.top - VIEWPORT_MARGIN - TRIGGER_GAP;
  const spaceBelow = viewport.height - trigger.bottom - VIEWPORT_MARGIN - TRIGGER_GAP;
  const placement = spaceBelow >= fitted.height || spaceBelow >= spaceAbove ? 'below' : 'above';
  const desiredTop = placement === 'below'
    ? trigger.bottom + TRIGGER_GAP
    : trigger.top - TRIGGER_GAP - fitted.height;
  const maxTop = viewport.height - VIEWPORT_MARGIN - fitted.height;
  return {
    left,
    top: clamp(desiredTop, VIEWPORT_MARGIN, maxTop),
    placement,
  };
}
