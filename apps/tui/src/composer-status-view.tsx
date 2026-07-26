import type { ComposerStatus } from './composer-status.ts';
import { COLOR, contextUsageColor } from './tui-theme.ts';

export type ComposerStatusLayout = 'wide' | 'compact' | 'narrow';

/** Footer running status, mounted above the quiet input divider. */

/**
 * Crush-style neon for the activity field.
 *
 * Crush (internal/ui/anim) builds a continuous HCL gradient ramp between two
 * theme colors and, with CycleColors, loops A→B→A→B while advancing an offset
 * each frame. Peer previously stepped through 3 discrete semantic tokens, which
 * looked banded/harsh. We keep Frost accent↔info as the endpoints and sample a
 * smooth cycled ramp so glyphs shimmer instead of hard-jumping.
 */
const NEON_RAMP_STEPS = 24;

type Rgb = readonly [number, number, number];
type Hsl = readonly [number, number, number];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseHexColor(hex: string): Rgb | null {
  const raw = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]: Rgb): string {
  const to = (n: number) => Math.round(clamp01(n / 255) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl([r, g, b]: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      break;
    case gn:
      h = (bn - rn) / d + 2;
      break;
    default:
      h = (rn - gn) / d + 4;
      break;
  }
  return [h / 6, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  let tt = t;
  if (tt < 0) tt += 1;
  if (tt > 1) tt -= 1;
  if (tt < 1 / 6) return p + (q - p) * 6 * tt;
  if (tt < 1 / 2) return q;
  if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
  return p;
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** Shortest-path hue lerp in [0, 1). */
function lerpHue(a: number, b: number, t: number): number {
  let delta = b - a;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  return (a + delta * t + 1) % 1;
}

function blendColors(from: string, to: string, t: number): string {
  const a = parseHexColor(from);
  const b = parseHexColor(to);
  if (!a || !b) return from;
  const [h1, s1, l1] = rgbToHsl(a);
  const [h2, s2, l2] = rgbToHsl(b);
  const tt = clamp01(t);
  return rgbToHex(hslToRgb([
    lerpHue(h1, h2, tt),
    s1 + (s2 - s1) * tt,
    l1 + (l2 - l1) * tt,
  ]));
}

/**
 * Crush makeGradientRamp(size, stops...): multi-stop continuous blend.
 * CycleColors uses A,B,A,B so the field can scroll without a hard seam.
 */
function makeGradientRamp(size: number, stops: readonly string[]): string[] {
  if (size <= 0 || stops.length === 0) return [COLOR.accent];
  if (stops.length === 1 || size === 1) return Array.from({ length: size }, () => stops[0] ?? COLOR.accent);

  const numSegments = stops.length - 1;
  const baseSize = Math.floor(size / numSegments);
  const remainder = size % numSegments;
  const ramp: string[] = [];

  for (let i = 0; i < numSegments; i += 1) {
    const from = stops[i] ?? COLOR.accent;
    const to = stops[i + 1] ?? from;
    const segmentSize = baseSize + (i < remainder ? 1 : 0);
    for (let j = 0; j < segmentSize; j += 1) {
      const t = segmentSize <= 1 ? 0 : j / segmentSize;
      ramp.push(blendColors(from, to, t));
    }
  }
  return ramp;
}

let cachedNeonKey = '';
let cachedNeonRamp: string[] = [];

function neonGradientRamp(): string[] {
  // Live COLOR may flip light/dark; rebuild when endpoints change.
  const from = COLOR.accent;
  const to = COLOR.info;
  const key = `${from}|${to}|${NEON_RAMP_STEPS}`;
  if (key === cachedNeonKey && cachedNeonRamp.length > 0) return cachedNeonRamp;
  // A→B→A→B mirrors crush CycleColors gradient construction.
  cachedNeonRamp = makeGradientRamp(NEON_RAMP_STEPS * 2, [from, to, from, to]);
  cachedNeonKey = key;
  return cachedNeonRamp;
}

/** Per-character neon color; `frame` scrolls the crush-style gradient. */
export function neonActivityColor(index: number, frame = 0): string {
  const ramp = neonGradientRamp();
  const offset = Math.abs(index + frame) % ramp.length;
  return ramp[offset] ?? COLOR.accent;
}

export function ComposerRunningStatusBar({
  activity,
  statusLabel,
  frame = 0,
}: {
  readonly activity: string;
  readonly statusLabel: string;
  /** Animation frame — shifts per-character neon colors without changing glyphs. */
  readonly frame?: number;
}) {
  return (
    <box
      flexDirection="row"
      width="100%"
      flexShrink={0}
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
    >
      <text wrapMode="none">
        {[...activity].map((character, index) => (
          <span key={`${index}-${character}`} fg={neonActivityColor(index, frame)}>
            {character}
          </span>
        ))}
        <span fg={COLOR.textSoft}>  {statusLabel}</span>
      </text>
      <text fg={COLOR.subtle} wrapMode="none">
        <span>PEER</span>
        <span fg={COLOR.accent}> / ACTIVE</span>
      </text>
    </box>
  );
}

/** Thin rule between running status (if any) and the composer input. */
export function ComposerModeDivider({ width }: { readonly width: number }) {
  const cols = Math.max(1, Math.floor(width));
  return (
    <box width="100%" height={1} flexShrink={0}>
      <text fg={COLOR.subtle} wrapMode="none">
        {'─'.repeat(cols)}
      </text>
    </box>
  );
}

function StatusSeparator() {
  return <span fg={COLOR.subtle}> · </span>;
}

function StatusPair({ label, value, accent = false }: {
  readonly label: string;
  readonly value: string;
  readonly accent?: boolean;
}) {
  return (
    <>
      <span fg={COLOR.subtle}>{label} </span>
      <span fg={accent ? COLOR.accent : COLOR.textSoft}>{value}</span>
    </>
  );
}

export function contextMeterParts(percent: number | undefined, width: number): {
  readonly filled: string;
  readonly empty: string;
} {
  if (width <= 0) return { filled: '', empty: '' };
  const bounded = Math.max(0, Math.min(100, percent ?? 0));
  const filledCount = Math.round((bounded / 100) * width);
  return {
    filled: '█'.repeat(filledCount),
    empty: '░'.repeat(width - filledCount),
  };
}

export function contextMeter(percent: number | undefined, width: number): string {
  const { filled, empty } = contextMeterParts(percent, width);
  return `${filled}${empty}`;
}

function ContextStatus({ status, short = false }: {
  readonly status: ComposerStatus;
  readonly short?: boolean;
}) {
  const color = contextUsageColor(status.contextPercent);
  const width = short ? 6 : 12;
  const { filled, empty } = contextMeterParts(status.contextPercent, width);
  const percent = status.contextPercent === undefined ? '?' : `${status.contextPercent}%`;
  return (
    <>
      <span fg={color}>{filled}</span>
      <span fg={COLOR.muted}>{empty}</span>
      <span fg={color}> {percent}</span>
    </>
  );
}

/**
 * Below the input: mode · access on the left, model · effort + context on the right.
 * No lang / workspace here — workspace lives in the session topbar.
 */
function ModelEffortLabel({ status }: { readonly status: ComposerStatus }) {
  return (
    <>
      <span fg={COLOR.textSoft}>{status.model}</span>
      <StatusSeparator />
      <span fg={COLOR.textSoft}>{status.effort}</span>
    </>
  );
}

export function ComposerStatusBar({ status, layout }: {
  readonly status: ComposerStatus;
  readonly layout: ComposerStatusLayout;
}) {
  if (layout === 'narrow') {
    return (
      <box flexDirection="column" width="100%" paddingLeft={1} paddingTop={0}>
        <text fg={COLOR.muted} wrapMode="none">
          <StatusPair label="mode" value={status.mode} accent />
          <StatusSeparator />
          <StatusPair label="access" value={status.permissionShort} />
        </text>
        <text fg={COLOR.muted} wrapMode="none">
          <ModelEffortLabel status={status} />
          {' '}
          <ContextStatus status={status} short />
        </text>
      </box>
    );
  }

  return (
    <box
      width="100%"
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingTop={0}
    >
      <text fg={COLOR.muted} wrapMode="none">
        <StatusPair label="mode" value={status.mode} accent />
        <StatusSeparator />
        <StatusPair
          label="access"
          value={layout === 'compact' ? status.permissionShort : status.permission}
        />
      </text>
      <text fg={COLOR.muted} wrapMode="none">
        <ModelEffortLabel status={status} />
        {' '}
        <ContextStatus status={status} short={layout === 'compact'} />
      </text>
    </box>
  );
}
