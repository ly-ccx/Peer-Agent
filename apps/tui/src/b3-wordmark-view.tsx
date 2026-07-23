import { useEffect, useState } from 'react';
import {
  renderB3Wordmark,
  type B3ColorRole,
  type B3TerminalLine,
  type B3TerminalVariant,
} from './b3-wordmark.ts';
import { COLOR } from './tui-theme.ts';

/**
 * Map wordmark roles onto the live Frost palette so light mode uses dark ink
 * and dark mode keeps the original light glyphs.
 */
export function resolveB3WordmarkColor(role: B3ColorRole): string {
  switch (role) {
    case 'primary':
      return COLOR.text;
    case 'signal':
      return COLOR.info;
    case 'muted':
      return COLOR.muted;
  }
}

function colorForRole(role: B3ColorRole | undefined): string | undefined {
  return role ? resolveB3WordmarkColor(role) : undefined;
}

// ── Animation helpers ──────────────────────────────────────────────

/** Reveal one new line every REVEAL_STEP_MS until all rows are visible. */
const REVEAL_STEP_MS = 100;
/** Breathing cycle period in milliseconds (≈ 2 s full sine wave). */
const BREATHE_PERIOD_MS = 2000;
/** Breathing tick interval — ~8 fps keeps CPU low while staying smooth. */
const BREATHE_TICK_MS = 125;

/** How much the signal color can brighten at peak (0 = none, 1 = full white). */
const BREATHE_AMPLITUDE = 0.35;

function lerpHex(a: string, b: string, t: number): string {
  const pa = Number.parseInt(a.slice(1), 16);
  const pb = Number.parseInt(b.slice(1), 16);
  const ar = (pa >> 16) & 0xff;
  const ag = (pa >> 8) & 0xff;
  const ab = pa & 0xff;
  const br = (pb >> 16) & 0xff;
  const bg = (pb >> 8) & 0xff;
  const bb = pb & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

/**
 * Returns a brightened signal color for the breathing animation.
 * `phase` ranges from 0 to 1 over the full breathe cycle.
 */
export function breatheSignalColor(phase: number): string {
  const base = COLOR.info;
  // Sine wave: 0 at start, 1 at midpoint, 0 at end.
  const sine = (Math.sin(phase * Math.PI * 2 - Math.PI / 2) + 1) / 2;
  const t = sine * BREATHE_AMPLITUDE;
  return lerpHex(base, COLOR.brandHighlight, t);
}

// ── Line renderer ──────────────────────────────────────────────────

function B3WordmarkLine({
  line,
  signalOverride,
}: {
  readonly line: B3TerminalLine;
  readonly signalOverride?: string;
}) {
  return (
    <text>
      {line.segments.map((segment, index) => {
        let fg = colorForRole(segment.fg);
        let bg = colorForRole(segment.bg);
        if (segment.fg === 'signal' && signalOverride) fg = signalOverride;
        if (segment.bg === 'signal' && signalOverride) bg = signalOverride;
        return (
          <span
            key={`${index}:${segment.text}`}
            fg={fg}
            bg={bg}
          >
            {segment.text}
          </span>
        );
      })}
    </text>
  );
}

// ── Main component ─────────────────────────────────────────────────

export function B3Wordmark({ variant }: { readonly variant: B3TerminalVariant }) {
  const wordmark = renderB3Wordmark(variant);

  // Phase 1: line-by-line reveal. `revealedRows` goes from 0 → wordmark.height.
  const [revealedRows, setRevealedRows] = useState(0);

  // Phase 2: continuous signal breathing after reveal completes.
  const [breathePhase, setBreathePhase] = useState(0);

  // Reveal timer — one-shot, increments rows every REVEAL_STEP_MS.
  useEffect(() => {
    setRevealedRows(0);
    const timer = setInterval(() => {
      setRevealedRows((current) => {
        if (current >= wordmark.height) {
          clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, REVEAL_STEP_MS);
    return () => clearInterval(timer);
  }, [variant, wordmark.height]);

  // Breathing timer — starts after reveal completes, runs continuously.
  useEffect(() => {
    if (revealedRows < wordmark.height) return;
    const start = Date.now();
    const timer = setInterval(() => {
      const elapsed = (Date.now() - start) % BREATHE_PERIOD_MS;
      setBreathePhase(elapsed / BREATHE_PERIOD_MS);
    }, BREATHE_TICK_MS);
    return () => clearInterval(timer);
  }, [revealedRows, wordmark.height]);

  const revealComplete = revealedRows >= wordmark.height;
  const signalColor = revealComplete ? breatheSignalColor(breathePhase) : undefined;

  return (
    <box
      width={wordmark.width}
      height={wordmark.height}
      flexDirection="column"
      alignItems="flex-start"
    >
      {wordmark.lines.map((line, index) => (
        <B3WordmarkLine
          key={`${variant}:${index}`}
          line={line}
          signalOverride={index < revealedRows ? signalColor : undefined}
        />
      ))}
    </box>
  );
}
