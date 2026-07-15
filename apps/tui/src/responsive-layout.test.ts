import { describe, expect, test } from 'bun:test';

import { responsiveLayout } from './responsive-layout.ts';

describe('responsive TUI layout', () => {
  test.each([
    [120, 'wide', true, true, false, 2, '75%'],
    [100, 'compact', true, true, false, 1, '88%'],
    [80, 'compact', true, true, false, 1, '88%'],
    [60, 'narrow', false, true, true, 1, '100%'],
    [40, 'minimal', false, false, true, 0, '100%'],
  ] as const)('maps %i columns to an explicit information density', (
    columns, density, showDescriptions, showHints, stackActions, outerPadding, welcomeWidth,
  ) => {
    expect(responsiveLayout(columns)).toEqual({
      density, showDescriptions, showHints, stackActions, outerPadding, welcomeWidth,
    });
  });

  test('preserves decisions by changing layout rather than hiding actions', () => {
    expect(responsiveLayout(40).stackActions).toBe(true);
    expect(responsiveLayout(40).showDescriptions).toBe(false);
  });
});
