import { describe, expect, test } from 'bun:test';

import { composerDisplayWidth, composerLayoutModel } from './composer-layout-model.ts';

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
    // usableWidth = contentWidth - 4 = 36. Each 中 is 2 cols → 20 glyphs = 40 cols → 2 rows.
    const chinese = composerLayoutModel({
      draft: '中'.repeat(20),
      contentWidth: 40,
      runtimeStatus: 'idle',
    });
    expect(composerDisplayWidth('中'.repeat(20))).toBe(40);
    expect(chinese.inputRows).toBe(2);

    // Same glyph count under string.length would stay 1 row if we only used length;
    // display-width math must force growth earlier than ASCII of equal length.
    const asciiSameLength = composerLayoutModel({
      draft: 'a'.repeat(20),
      contentWidth: 40,
      runtimeStatus: 'idle',
    });
    expect(asciiSameLength.inputRows).toBe(1);
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
