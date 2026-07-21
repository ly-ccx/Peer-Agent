import { describe, expect, test } from 'bun:test';

import { composerContentWidth, responsiveLayout, responsivePickerLayout } from './responsive-layout.ts';

describe('responsive TUI layout', () => {
  test.each([
    [120, 'wide', true, true, false, 3, 1, '75%'],
    [100, 'compact', true, true, false, 2, 1, '88%'],
    [80, 'compact', true, true, false, 2, 1, '88%'],
    [60, 'narrow', false, true, true, 1, 1, '100%'],
    [40, 'minimal', false, false, true, 0, 0, '100%'],
  ] as const)('maps %i columns to an explicit information density', (
    columns, density, showDescriptions, showHints, stackActions, outerPadding, outerPaddingY, welcomeWidth,
  ) => {
    expect(responsiveLayout(columns)).toEqual({
      density, showDescriptions, showHints, stackActions, outerPadding, outerPaddingY, welcomeWidth,
    });
  });

  test.each([
    [120, 3, 114],
    [100, 2, 96],
    [80, 2, 76],
    [60, 1, 58],
    [40, 0, 40],
    [5, 3, 1],
  ] as const)('composer content width for %i columns with pad %i is %i', (columns, outerPadding, expected) => {
    expect(composerContentWidth(columns, outerPadding)).toBe(expected);
  });

  test('preserves decisions by changing layout rather than hiding actions', () => {
    expect(responsiveLayout(40).stackActions).toBe(true);
    expect(responsiveLayout(40).showDescriptions).toBe(false);
  });

  test.each([
    [14, false, false, false, 0, 6, 11],
    [17, true, false, true, 0, 8, 12],
    [20, true, true, true, 1, 13, 6],
  ] as const)('keeps picker content within the vertical budget at %i rows', (
    rows,
    showContext,
    showDescriptions,
    showHints,
    verticalPadding,
    modePanelRows,
    commandMaxVisible,
  ) => {
    expect(responsivePickerLayout(rows, 3)).toEqual({
      showContext,
      showDescriptions,
      showHints,
      verticalPadding,
      modePanelRows,
      commandMaxVisible,
    });

    if (rows >= 14) {
      const composerAndGapRows = 7;
      expect(modePanelRows + composerAndGapRows).toBeLessThanOrEqual(rows);
    }
  });

  test('does not reserve rows for descriptions or hints hidden by narrow layouts', () => {
    expect(responsivePickerLayout(20, 3, false, false)).toEqual({
      showContext: true,
      showDescriptions: false,
      showHints: false,
      verticalPadding: 0,
      modePanelRows: 7,
      commandMaxVisible: 16,
    });
  });
});
