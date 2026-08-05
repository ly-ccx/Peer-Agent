import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

import { DARK_PALETTE, LIGHT_PALETTE, type TuiPalette } from './tui-theme.ts';
import {
  themedTextSelectionProps,
  themedTextareaStateProps,
} from './themed-primitives.tsx';

const SOURCE_ROOT = path.dirname(new URL(import.meta.url).pathname);
const GOVERNED_EXTENSIONS = new Set(['.ts', '.tsx']);
const RAW_COLOR_EXCEPTIONS = new Set([
  // Brand source artwork is immutable asset data, not interface styling.
  'b3-wordmark.ts',
  // Palette definitions are the only visual source of truth.
  'tui-theme.ts',
]);

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    if (!GOVERNED_EXTENSIONS.has(path.extname(entry.name))) return [];
    if (/\.test\.[^.]+$/.test(entry.name)) return [];
    return [absolute];
  });
}

function relative(file: string): string {
  return path.relative(SOURCE_ROOT, file);
}

function hexRgb(color: string): [number, number, number] {
  const normalized = color.replace(/^#/, '');
  const expanded = normalized.length === 3
    ? normalized.split('').map((part) => part + part).join('')
    : normalized;
  if (!/^[0-9a-f]{6}$/i.test(expanded)) throw new Error(`Unsupported color: ${color}`);
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(color: string): number {
  const channels = hexRgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrast(foreground: string, background: string): number {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function expectReadable(palette: TuiPalette, foreground: keyof TuiPalette, background: keyof TuiPalette) {
  expect(
    contrast(palette[foreground], palette[background]),
    `${String(foreground)} on ${String(background)}`,
  ).toBeGreaterThanOrEqual(4.5);
}

describe('TUI theme governance', () => {
  test('keeps light and dark palettes structurally identical and populated', () => {
    expect(Object.keys(LIGHT_PALETTE).sort()).toEqual(Object.keys(DARK_PALETTE).sort());
    for (const [name, value] of Object.entries(LIGHT_PALETTE)) {
      expect(value, `light.${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    for (const [name, value] of Object.entries(DARK_PALETTE)) {
      expect(value, `dark.${name}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('keeps text, text selection, input and input selection readable in both schemes', () => {
    for (const palette of [LIGHT_PALETTE, DARK_PALETTE]) {
      expectReadable(palette, 'text', 'background');
      expectReadable(palette, 'textSelectionForeground', 'textSelectionBackground');
      expectReadable(palette, 'inputForeground', 'inputBackground');
      expectReadable(palette, 'inputSelectionForeground', 'inputSelectionBackground');
    }
  });

  test('binds native OpenTUI selection, input, focus and cursor states to semantic tokens', () => {
    for (const palette of [LIGHT_PALETTE, DARK_PALETTE]) {
      const text = themedTextSelectionProps(palette);
      expect(text).toEqual({
        selectionBg: palette.textSelectionBackground,
        selectionFg: palette.textSelectionForeground,
      });

      const input = themedTextareaStateProps(palette);
      expect(input).toMatchObject({
        backgroundColor: palette.inputBackground,
        textColor: palette.inputForeground,
        placeholderColor: palette.inputPlaceholder,
        selectionBg: palette.inputSelectionBackground,
        selectionFg: palette.inputSelectionForeground,
        cursorColor: palette.inputCursor,
      });
      expect(palette.borderFocus).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  test('rejects raw colors outside the theme module and explicit brand asset', () => {
    const violations = sourceFiles().flatMap((file) => {
      if (RAW_COLOR_EXCEPTIONS.has(relative(file))) return [];
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(/#[0-9a-f]{3,8}\b|(?<![a-z0-9_])rgba?\s*\(/gi)].map((match) => `${relative(file)}:${match.index}:${match[0]}`);
    });
    expect(violations).toEqual([]);
  });

  test('rejects raw selectable text, raw textarea and native selection overrides in business surfaces', () => {
    const violations = sourceFiles().flatMap((file) => {
      if (relative(file) === 'themed-primitives.tsx') return [];
      const source = readFileSync(file, 'utf8');
      const found: string[] = [];
      for (const match of source.matchAll(/<text\b[\s\S]*?>/g)) {
        if (/\bselectable(?:\s|=|>)/.test(match[0])) found.push(`${relative(file)}: raw selectable text`);
        if (/\bselection(?:Bg|Fg)=/.test(match[0])) found.push(`${relative(file)}: native text selection override`);
      }
      if (/<textarea\b/.test(source)) found.push(`${relative(file)}: raw textarea`);
      if (/\b(?:selectionBg|selectionFg|cursorColor)=/.test(source)) found.push(`${relative(file)}: native interaction color override`);
      return found;
    });
    expect(violations).toEqual([]);
  });
});
