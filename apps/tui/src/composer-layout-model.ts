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
 * Columns reserved left of the textarea inside the composer content width:
 * prompt glyph (1) + paddingLeft (1). Add 1 for layout rounding so estimates
 * grow slightly before the true right edge rather than after it.
 */
export const COMPOSER_INPUT_CHROME_COLS = 3;

/**
 * Terminal display columns for a string. Wide East-Asian glyphs count as 2 so
 * soft-wrap row estimates match what the terminal actually paints.
 */
export function composerDisplayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
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

function clampComposerRows(rows: number): number {
  if (!Number.isFinite(rows)) return 1;
  return Math.min(5, Math.max(1, Math.floor(rows)));
}

/**
 * Pure presentation model for the borderless composer. The editor grows upward
 * with its draft while remaining bounded so conversation history stays primary.
 *
 * Prefer OpenTUI `virtualLineCount` (soft-wrapped visual rows) when measured.
 * Fall back to display-width estimation so height can still grow before the
 * first measure lands.
 */
export function composerLayoutModel(input: {
  readonly draft: string;
  readonly contentWidth: number;
  readonly runtimeStatus: ComposerVisualState;
  /** Soft-wrapped visual rows reported by the live textarea, when available. */
  readonly measuredVisualRows?: number;
}): ComposerLayoutModel {
  const usableWidth = Math.max(12, input.contentWidth - COMPOSER_INPUT_CHROME_COLS);
  const estimatedRows = Math.max(
    1,
    input.draft.split('\n').reduce((rows, line) => {
      const cols = composerDisplayWidth(line);
      return rows + Math.max(1, Math.ceil(cols / usableWidth));
    }, 0),
  );
  const measuredRows = input.measuredVisualRows == null
    ? 1
    : clampComposerRows(input.measuredVisualRows);
  const inputRows = clampComposerRows(Math.max(estimatedRows, measuredRows));
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
