import { describe, expect, test } from 'bun:test';

import { composerLayoutModel } from './composer-layout-model.ts';

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

  test('uses the active prompt and status for every runtime state', () => {
    for (const runtimeStatus of ['running', 'cancelling', 'compacting'] as const) {
      const model = composerLayoutModel({ draft: '', contentWidth: 80, runtimeStatus });
      expect(model.showRunningStatus).toBe(true);
      expect(model.pickerBottom).toBe(3);
      expect(model.promptGlyph).toBe('◆');
    }
  });
});
