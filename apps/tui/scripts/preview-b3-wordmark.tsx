#!/usr/bin/env bun

import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from '@opentui/react';

import {
  B3_WORDMARK_COLORS,
  renderB3Wordmark,
  type B3ColorRole,
  type B3TerminalLine,
  type B3TerminalVariant,
} from '../src/b3-wordmark.ts';

const BACKGROUND = '#090a0c';
const PANEL = '#15171c';
const BORDER = '#31343b';
const MUTED = '#777a83';
const TEXT = '#efede7';
const requestedVariant = process.argv.find((value): value is `--variant=${B3TerminalVariant}` => value.startsWith('--variant='))
  ?.slice('--variant='.length) as B3TerminalVariant | undefined;
const forceVariant = requestedVariant && ['full', 'half', 'narrow'].includes(requestedVariant)
  ? requestedVariant
  : undefined;
const exitAfterMs = Number(process.env.PEER_B3_PREVIEW_EXIT_MS ?? '0');

function colorForRole(role: B3ColorRole | undefined): string | undefined {
  return role ? B3_WORDMARK_COLORS[role] : undefined;
}

function Line({ line }: { readonly line: B3TerminalLine }) {
  return (
    <text>
      {line.segments.map((segment, index) => (
        <span
          key={`${index}:${segment.text}`}
          fg={colorForRole(segment.fg)}
          bg={colorForRole(segment.bg)}
        >
          {segment.text}
        </span>
      ))}
    </text>
  );
}

function Wordmark({ variant }: { readonly variant: B3TerminalVariant }) {
  const wordmark = renderB3Wordmark(variant);
  return (
    <box flexDirection="column" alignItems="flex-start">
      {wordmark.lines.map((line, index) => <Line key={`${variant}:${index}`} line={line} />)}
    </box>
  );
}

function variantForWidth(width: number): B3TerminalVariant {
  if (forceVariant) {
    return forceVariant;
  }
  if (width >= 76) {
    return 'full';
  }
  if (width >= 42) {
    return 'half';
  }
  return 'narrow';
}

function PreviewApp() {
  const renderer = useRenderer();
  const terminal = useTerminalDimensions();
  const variant = variantForWidth(terminal.width);
  const wordmark = renderB3Wordmark(variant);

  useKeyboard((key) => {
    if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
      renderer.destroy();
    }
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={BACKGROUND}
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="column" alignItems="center" gap={2}>
        <text fg={MUTED}>B3 · SIGNAL / REAL OPENTUI CHARACTERS</text>
        <Wordmark variant={variant} />
        <box
          width={Math.min(Math.max(wordmark.width + 6, 24), Math.max(24, terminal.width - 4))}
          height={3}
          border
          borderColor={BORDER}
          backgroundColor={PANEL}
          alignItems="center"
          paddingLeft={2}
        >
          <text fg={MUTED}>Ask anything…</text>
        </box>
        <text fg={MUTED}>
          {`${wordmark.label} · ${wordmark.width}×${wordmark.height} · terminal ${terminal.width}×${terminal.height}`}
        </text>
        <text fg={TEXT}>q / esc quit</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  clearOnShutdown: false,
});
renderer.setBackgroundColor(BACKGROUND);
const root = createRoot(renderer);
root.render(<PreviewApp />);

if (Number.isFinite(exitAfterMs) && exitAfterMs > 0) {
  setTimeout(() => {
    root.unmount();
    renderer.destroy();
  }, exitAfterMs);
}
