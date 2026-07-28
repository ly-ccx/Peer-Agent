import { describe, expect, test } from 'bun:test';

import {
  contextMeter,
  contextMeterParts,
  neonActivityColor,
  showCacheStatus,
} from './composer-status-view.tsx';
import type { ComposerStatus } from './composer-status.ts';
import { COLOR } from './tui-theme.ts';

describe('composer context meter', () => {
  test('renders bounded usage as a chunky block meter', () => {
    expect(contextMeter(25, 8)).toBe('██░░░░░░');
    expect(contextMeter(150, 4)).toBe('████');
    expect(contextMeter(undefined, 4)).toBe('░░░░');
  });

  test('splits solid filled blocks from the light empty track for dual-tone rendering', () => {
    expect(contextMeterParts(25, 8)).toEqual({ filled: '██', empty: '░░░░░░' });
    expect(contextMeterParts(150, 4)).toEqual({ filled: '████', empty: '' });
    expect(contextMeterParts(undefined, 4)).toEqual({ filled: '', empty: '░░░░' });
  });
});

describe('composer cache status', () => {
  const status = { cache: 'cache 20%' } as ComposerStatus;

  test('shows cache before context only in the wide layout', () => {
    expect(showCacheStatus('wide', status)).toBe(true);
    expect(showCacheStatus('compact', status)).toBe(false);
    expect(showCacheStatus('narrow', status)).toBe(false);
  });

  test('hides cache when the latest request has no reliable cache data', () => {
    expect(showCacheStatus('wide', {} as ComposerStatus)).toBe(false);
  });
});

describe('crush-style neon activity colors', () => {
  test('returns continuous hex colors rather than a 3-token discrete palette', () => {
    const samples = Array.from({ length: 12 }, (_, index) => neonActivityColor(index, 0));
    for (const sample of samples) {
      expect(sample).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // Adjacent glyphs should not hard-jump between only accent/info/success.
    const unique = new Set(samples);
    expect(unique.size).toBeGreaterThan(3);
  });

  test('scrolls the gradient when the animation frame advances', () => {
    expect(neonActivityColor(0, 1)).not.toBe(neonActivityColor(0, 0));
    // Frame shift should match spatial shift (crush offset = index + frame).
    expect(neonActivityColor(0, 3)).toBe(neonActivityColor(3, 0));
  });

  test('stays within Frost accent↔info family endpoints', () => {
    const endpoints = new Set([COLOR.accent.toLowerCase(), COLOR.info.toLowerCase()]);
    const first = neonActivityColor(0, 0).toLowerCase();
    expect(first).toMatch(/^#[0-9a-f]{6}$/);
    // At least one sample in a full cycle should hit an endpoint stop.
    const cycle = Array.from({ length: 48 }, (_, index) => neonActivityColor(index, 0).toLowerCase());
    expect(cycle.some((color) => endpoints.has(color))).toBe(true);
  });
});
