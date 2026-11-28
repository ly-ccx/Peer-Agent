export interface CubicSegment {
  readonly cp1x: number;
  readonly cp1y: number;
  readonly cp2x: number;
  readonly cp2y: number;
  readonly x: number;
  readonly y: number;
}

export interface RevealFrame {
  readonly scaleX: number;
  readonly scaleY: number;
  readonly solidOpacity: number;
  readonly veilOpacity: number;
  readonly rimOpacity: number;
  readonly scrimOpacity: number;
}

/**
 * Centered kitten-head silhouette in local units around the face core (0, 0).
 * Top forehead sits at y = -47, rounded ear tips near y = -79, plump cheeks
 * reach x = ±76, and chin rests at y = +52.
 */
export const CAT_SILHOUETTE_START = { x: 0, y: -47 } as const;
export const CAT_SILHOUETTE_VIEWBOX = '-100 -111 200 200' as const;
export const CAT_ANCHOR_X_RATIO = 0.5;
export const CAT_ANCHOR_Y_RATIO = 111 / 200;
export const CAT_INNER_RADIUS = 44;

export const CAT_BOUNCE_DURATION_MS = 560;
export const CAT_REVEAL_DURATION_MS = 680;

export const CAT_SILHOUETTE_SEGMENTS: readonly CubicSegment[] = [
  // Right crown to right ear valley
  { cp1x: 8, cp1y: -47, cp2x: 15, cp2y: -46, x: 20, y: -43 },
  // Right ear inner rise to rounded tip
  { cp1x: 27, cp1y: -59, cp2x: 38, cp2y: -73, x: 46, y: -77 },
  // Right ear rounded tip
  { cp1x: 52, cp1y: -80, cp2x: 59, cp2y: -77, x: 59, y: -71 },
  // Right ear outer edge to temple
  { cp1x: 62, cp1y: -52, cp2x: 63, cp2y: -36, x: 61, y: -22 },
  // Right plump cheek
  { cp1x: 67, cp1y: -11, cp2x: 69, cp2y: 0, x: 68, y: 12 },
  // Right lower cheek to soft rounded chin
  { cp1x: 67, cp1y: 38, cp2x: 39, cp2y: 56, x: 0, y: 56 },
  // Left lower cheek (exact horizontal mirror)
  { cp1x: -39, cp1y: 56, cp2x: -67, cp2y: 38, x: -68, y: 12 },
  // Left plump cheek to temple
  { cp1x: -69, cp1y: 0, cp2x: -67, cp2y: -11, x: -61, y: -22 },
  // Left ear outer edge
  { cp1x: -63, cp1y: -36, cp2x: -62, cp2y: -52, x: -59, y: -71 },
  // Left ear rounded tip
  { cp1x: -59, cp1y: -77, cp2x: -52, cp2y: -80, x: -46, y: -77 },
  // Left ear inner drop to valley
  { cp1x: -38, cp1y: -73, cp2x: -27, cp2y: -59, x: -20, y: -43 },
  // Left crown back to top center
  { cp1x: -15, cp1y: -46, cp2x: -8, cp2y: -47, x: 0, y: -47 },
];

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function buildCatSilhouettePath(options?: {
  readonly cx?: number;
  readonly cy?: number;
  readonly scaleX?: number;
  readonly scaleY?: number;
}): string {
  const cx = options?.cx ?? 0;
  const cy = options?.cy ?? 0;
  const sx = options?.scaleX ?? 1;
  const sy = options?.scaleY ?? sx;
  const startX = cx + CAT_SILHOUETTE_START.x * sx;
  const startY = cy + CAT_SILHOUETTE_START.y * sy;
  const parts = [`M ${fmt(startX)} ${fmt(startY)}`];
  for (const seg of CAT_SILHOUETTE_SEGMENTS) {
    parts.push(
      `C ${fmt(cx + seg.cp1x * sx)} ${fmt(cy + seg.cp1y * sy)}, ${fmt(cx + seg.cp2x * sx)} ${fmt(cy + seg.cp2y * sy)}, ${fmt(cx + seg.x * sx)} ${fmt(cy + seg.y * sy)}`,
    );
  }
  parts.push('Z');
  return parts.join(' ');
}

export function buildCutoutOverlayPath(options: {
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
  readonly scaleX: number;
  readonly scaleY: number;
}): string {
  const pad = 64;
  const w = Math.max(1, options.width) + pad * 2;
  const h = Math.max(1, options.height) + pad * 2;
  const outer = `M ${-pad} ${-pad} h ${fmt(w)} v ${fmt(h)} h ${fmt(-w)} Z`;
  const inner = buildCatSilhouettePath({
    cx: options.cx,
    cy: options.cy,
    scaleX: options.scaleX,
    scaleY: options.scaleY,
  });
  return `${outer} ${inner}`;
}

export function computeRevealTargetScale(options: {
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
  readonly baseScale: number;
}): number {
  const safeBase = Math.max(0.1, options.baseScale);
  const dx = Math.max(options.cx, options.width - options.cx);
  const dy = Math.max(options.cy, options.height - options.cy);
  const maxCornerDistance = Math.hypot(dx, dy);
  const required = (maxCornerDistance / (CAT_INNER_RADIUS * safeBase)) * 1.25;
  return Math.max(32, Math.ceil(required));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(t: number): number {
  const inv = 1 - clamp01(t);
  return 1 - inv * inv * inv;
}

function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

const ANTICIPATION_SPLIT = 0.18;
const PULLBACK_BASE_SCALE = 0.88;

export function sampleRevealFrame(progress: number, targetScale: number): RevealFrame {
  const p = clamp01(progress);
  const endScale = Math.max(1, targetScale);

  if (p < ANTICIPATION_SPLIT) {
    const t = easeInOutCubic(p / ANTICIPATION_SPLIT);
    return {
      scaleX: 1 - 0.08 * t,
      scaleY: 1 - 0.16 * t,
      solidOpacity: 1,
      veilOpacity: 0,
      rimOpacity: 0,
      scrimOpacity: 1,
    };
  }

  const u = clamp01((p - ANTICIPATION_SPLIT) / (1 - ANTICIPATION_SPLIT));
  // Mild ease-in exponent gives constant optical expansion across mid-reveal.
  const exponent = u * (0.55 + 0.45 * u);
  const base = PULLBACK_BASE_SCALE * Math.pow(endScale / PULLBACK_BASE_SCALE, exponent);
  const squashBlend = 1 - easeOutCubic(clamp01(u / 0.24));
  const ratioX = 1 + 0.045 * squashBlend;
  const ratioY = 1 - 0.045 * squashBlend;

  const solidOpacity = 1 - easeInOutCubic(clamp01((u - 0.01) / 0.18));
  const veilOpacity = 0.44 * (1 - easeOutCubic(clamp01((u - 0.06) / 0.26)));
  const rimProgress = clamp01((u - 0.03) / 0.65);
  const rimOpacity = rimProgress > 0 && rimProgress < 1 ? 0.55 * Math.sin(Math.PI * rimProgress) : 0;
  const scrimOpacity = u <= 0.92 ? 1 : 1 - easeOutCubic((u - 0.92) / 0.08);

  return {
    scaleX: base * ratioX,
    scaleY: base * ratioY,
    solidOpacity,
    veilOpacity,
    rimOpacity,
    scrimOpacity,
  };
}
