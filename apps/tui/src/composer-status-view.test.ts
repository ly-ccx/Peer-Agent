import { describe, expect, test } from 'bun:test';

import {
  activitySweepColor,
  activitySweepIntensity,
  contextMeter,
  contextMeterParts,
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

describe('activity highlight sweep', () => {
  test('keeps a stable rest color when the highlight is off the label', () => {
    const rest = activitySweepColor(0, 0, 10);
    expect(rest).toMatch(/^#[0-9a-fA-F]{6}$/);
    for (let index = 1; index < 10; index += 1) {
      expect(activitySweepColor(index, 0, 10)).toBe(rest);
    }
    expect(activitySweepIntensity(0, 0, 10)).toBe(0);
  });

  test('moves a bright peak across the label as the frame advances', () => {
    const length = 10;
    const peaks = Array.from({ length: 28 }, (_, frame) => {
      const intensities = Array.from({ length }, (_, index) => activitySweepIntensity(index, frame, length));
      const value = Math.max(...intensities);
      return { frame, index: intensities.indexOf(value), value };
    }).filter((entry) => entry.value === 1);

    expect(peaks.length).toBeGreaterThan(0);
    const firstPass = peaks.filter((entry) => entry.frame < peaks[0]!.frame + length);
    expect(firstPass.map((entry) => entry.index)).toEqual(Array.from({ length }, (_, index) => index));
    expect(activitySweepColor(firstPass[0]!.index, firstPass[0]!.frame, length))
      .not.toBe(activitySweepColor(0, 0, length));
  });

  test('peaks toward brand highlight rather than a rainbow ramp', () => {
    const peakFrame = Array.from({ length: 24 }, (_, frame) => frame)
      .find((frame) => activitySweepIntensity(0, frame, 10) === 1);
    expect(peakFrame).toBeDefined();
    expect(activitySweepColor(0, peakFrame!, 10).toLowerCase()).toBe(COLOR.brandHighlight.toLowerCase());
  });
});
