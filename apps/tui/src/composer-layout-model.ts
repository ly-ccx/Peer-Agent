export type ComposerVisualState = 'idle' | 'running' | 'cancelling' | 'compacting';

export interface ComposerLayoutModel {
  readonly state: ComposerVisualState;
  readonly inputRows: number;
  readonly shellRows: number;
  /** Anchor picker content above the input shell, divider, and optional running row. */
  readonly pickerBottom: number;
  readonly showRunningStatus: boolean;
  readonly promptGlyph: '›' | '◆';
}

/**
 * Terminal display columns for a string. Wide East-Asian glyphs count as 2 so
 * soft-wrap row estimates match what the terminal actually paints.
 */
export function composerDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // Surrogate pairs / emoji modifiers: treat non-BMP as width 2 when wide.
    if (
      code >= 0x1100 && (
        code <= 0x115f
        || code === 0x2329
        || code === 0x232a
        || (code >= 0x2e80 && code <= 0x303e)
        || (code >= 0x3041 && code <= 0x33ff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xa000 && code <= 0xa4cf)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe10 && code <= 0xfe19)
        || (code >= 0xfe30 && code <= 0xfe6f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x1f300 && code <= 0x1faff)
        || (code >= 0x20000 && code <= 0x3fffd)
      )
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * Pure presentation model for the borderless composer. The editor grows upward
 * with its draft while remaining bounded so conversation history stays primary.
 *
 * Row count uses terminal display width (not JS string length) so CJK input
 * soft-wraps and grows the shell at the true right edge.
 */
export function composerLayoutModel(input: {
  readonly draft: string;
  readonly contentWidth: number;
  readonly runtimeStatus: ComposerVisualState;
}): ComposerLayoutModel {
  // Reserve columns for the prompt glyph + gap so estimates match the textarea width.
  const usableWidth = Math.max(12, input.contentWidth - 4);
  const visualRows = Math.max(
    1,
    input.draft.split('\n').reduce((rows, line) => {
      const cols = composerDisplayWidth(line);
      return rows + Math.max(1, Math.ceil(cols / usableWidth));
    }, 0),
  );
  const inputRows = Math.min(5, visualRows);
  const showRunningStatus = input.runtimeStatus !== 'idle';

  return {
    state: input.runtimeStatus,
    inputRows,
    shellRows: inputRows,
    pickerBottom: inputRows + 1 + (showRunningStatus ? 1 : 0),
    showRunningStatus,
    promptGlyph: showRunningStatus ? '◆' : '›',
  };
}
