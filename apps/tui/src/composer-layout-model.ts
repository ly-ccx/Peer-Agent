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
 * Pure presentation model for the borderless composer. The editor grows upward
 * with its draft while remaining bounded so conversation history stays primary.
 */
export function composerLayoutModel(input: {
  readonly draft: string;
  readonly contentWidth: number;
  readonly runtimeStatus: ComposerVisualState;
}): ComposerLayoutModel {
  const usableWidth = Math.max(12, input.contentWidth - 4);
  const visualRows = Math.max(
    1,
    input.draft.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / usableWidth)), 0),
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
