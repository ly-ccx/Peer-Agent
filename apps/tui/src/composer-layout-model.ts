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
 * prompt glyph (1) + paddingLeft (1). Keep this exact so estimate width matches
 * the live textarea width instead of lagging one wrap behind.
 */
export const COMPOSER_INPUT_CHROME_COLS = 2;

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

export function clampComposerRows(rows: number): number {
  if (!Number.isFinite(rows)) return 1;
  return Math.min(5, Math.max(1, Math.floor(rows)));
}

/**
 * Soft-wrap visual rows for a draft at a known wrap width.
 *
 * This is the universal source of truth: pure function of (text, wrapWidth).
 * Do not feed height back into this calculation, or growth becomes a
 * chicken-and-egg that stalls after the first couple of wraps.
 */
export function estimateComposerVisualRows(draft: string, wrapWidth: number): number {
  const width = Math.max(1, Math.floor(wrapWidth));
  if (!draft) return 1;
  return Math.max(
    1,
    draft.split('\n').reduce((rows, line) => {
      // Empty hard-wrapped lines still occupy one visual row.
      const cols = line.length === 0 ? 0 : composerDisplayWidth(line);
      return rows + Math.max(1, Math.ceil(Math.max(cols, 1) / width));
    }, 0),
  );
}

/**
 * Usable textarea columns inside the composer content width.
 * Prefer the live editor width when available; otherwise contentWidth - chrome.
 */
export function composerWrapWidth(input: {
  readonly contentWidth: number;
  readonly measuredEditorWidth?: number;
}): number {
  const estimated = Math.max(1, Math.floor(input.contentWidth) - COMPOSER_INPUT_CHROME_COLS);
  const measured = input.measuredEditorWidth == null
    ? null
    : Math.max(1, Math.floor(input.measuredEditorWidth));
  // Prefer measured editor width when present, but never use a larger value than
  // the estimated content slot — a stale/overwide measure would under-count rows.
  if (measured == null) return Math.max(1, estimated);
  return Math.max(1, Math.min(estimated, measured));
}

/**
 * Pure presentation model for the borderless composer.
 *
 * Height is derived from draft + wrap width only. Optional measured visual
 * rows may raise the result, but they must never be required for growth.
 */
export function composerLayoutModel(input: {
  readonly draft: string;
  readonly contentWidth: number;
  readonly runtimeStatus: ComposerVisualState;
  /** Live textarea width in columns, when available. */
  readonly measuredEditorWidth?: number;
  /** Soft-wrapped visual rows reported by the live textarea, when available. */
  readonly measuredVisualRows?: number;
}): ComposerLayoutModel {
  const wrapWidth = composerWrapWidth({
    contentWidth: input.contentWidth,
    measuredEditorWidth: input.measuredEditorWidth,
  });
  const estimatedRows = estimateComposerVisualRows(input.draft, wrapWidth);
  const measuredRows = input.measuredVisualRows == null
    ? 0
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
