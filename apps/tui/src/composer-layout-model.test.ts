import { describe, expect, test } from 'bun:test';

import {
  COMPOSER_INPUT_CHROME_COLS,
  composerDisplayWidth,
  composerLayoutModel,
} from './composer-layout-model.ts';

describe('composer layout model', () => {
  test('keeps an empty idle composer compact and quiet', () => {
    expect(composerLayoutModel({ draft: '', contentWidth: 80, runtimeStatus: 'idle' })).toEqual({
      state: 'idle',
      inputRows: 1,
      shellRows: 1,
      pickerBottom: 2,
      showRunningStatus: false,
      promptGlyph: '›',
    });
  });

  test('grows with explicit and wrapped lines but stays bounded', () => {
    const multiline = composerLayoutModel({ draft: 'one\ntwo\nthree', contentWidth: 80, runtimeStatus: 'idle' });
    const capped = composerLayoutModel({ draft: 'x'.repeat(300), contentWidth: 40, runtimeStatus: 'idle' });

    expect(multiline.inputRows).toBe(3);
    expect(multiline.pickerBottom).toBe(4);
    expect(capped.inputRows).toBe(5);
    expect(capped.pickerBottom).toBe(6);
  });

  test('counts CJK characters as double width for soft-wrap growth', () => {
    // usableWidth = contentWidth - chrome. Each 中 is 2 cols.
    const usable = 40 - COMPOSER_INPUT_CHROME_COLS;
    const glyphs = Math.ceil((usable + 1) / 2); // just over one visual row
    const chinese = composerLayoutModel({
      draft: '中'.repeat(glyphs),
      contentWidth: 40,
      runtimeStatus: 'idle',
    });
    expect(composerDisplayWidth('中'.repeat(glyphs))).toBe(glyphs * 2);
    expect(chinese.inputRows).toBe(2);

    const asciiSameLength = composerLayoutModel({
      draft: 'a'.repeat(glyphs),
      contentWidth: 40,
      runtimeStatus: 'idle',
    });
    expect(asciiSameLength.inputRows).toBe(1);
  });

  test('prefers measured visual rows from the live textarea when larger', () => {
    const estimatedOnly = composerLayoutModel({
      draft: 'short',
      contentWidth: 80,
      runtimeStatus: 'idle',
    });
    expect(estimatedOnly.inputRows).toBe(1);

    const measured = composerLayoutModel({
      draft: 'short',
      contentWidth: 80,
      runtimeStatus: 'idle',
      measuredVisualRows: 3,
    });
    expect(measured.inputRows).toBe(3);
    expect(measured.shellRows).toBe(3);
    expect(measured.pickerBottom).toBe(4);
  });

  test('caps measured visual rows at five', () => {
    const measured = composerLayoutModel({
      draft: 'short',
      contentWidth: 80,
      runtimeStatus: 'idle',
      measuredVisualRows: 9,
    });
    expect(measured.inputRows).toBe(5);
  });

  test('uses the active prompt and status for every runtime state', () => {
    for (const runtimeStatus of ['running', 'cancelling', 'compacting'] as const) {
      const model = composerLayoutModel({ draft: '', contentWidth: 80, runtimeStatus });
      expect(model.showRunningStatus).toBe(true);
      expect(model.pickerBottom).toBe(3);
      expect(model.promptGlyph).toBe('◆');
    }
  });
});
