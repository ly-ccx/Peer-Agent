export type TuiLayoutDensity = 'wide' | 'compact' | 'narrow' | 'minimal';

export interface TuiResponsiveLayout {
  readonly density: TuiLayoutDensity;
  readonly showDescriptions: boolean;
  readonly showHints: boolean;
  readonly stackActions: boolean;
  readonly outerPadding: number;
  /** Vertical outer margin so chat / composer / status don't hug terminal edges. */
  readonly outerPaddingY: number;
  readonly welcomeWidth: `${number}%`;
}

export interface TuiResponsivePickerLayout {
  readonly showContext: boolean;
  readonly showDescriptions: boolean;
  readonly showHints: boolean;
  readonly verticalPadding: 0 | 1;
  readonly modePanelRows: number;
  readonly commandMaxVisible: number;
}

export function responsiveLayout(columns: number, rows = 24): TuiResponsiveLayout {
  const hasVerticalSafety = Math.max(1, Math.floor(rows)) >= 18;
  if (columns >= 120) return {
    density: 'wide', showDescriptions: true, showHints: true,
    stackActions: false, outerPadding: 3, outerPaddingY: hasVerticalSafety ? 1 : 0, welcomeWidth: '75%',
  };
  if (columns >= 80) return {
    density: 'compact', showDescriptions: true, showHints: true,
    stackActions: false, outerPadding: 2, outerPaddingY: hasVerticalSafety ? 1 : 0, welcomeWidth: '88%',
  };
  if (columns >= 60) return {
    density: 'narrow', showDescriptions: false, showHints: true,
    stackActions: true, outerPadding: 1, outerPaddingY: hasVerticalSafety ? 1 : 0, welcomeWidth: '100%',
  };
  return {
    density: 'minimal', showDescriptions: false, showHints: false,
    stackActions: true, outerPadding: 0, outerPaddingY: 0, welcomeWidth: '100%',
  };
}

/** Usable content columns after left/right outer padding (matches ComposerDock content width). */
export function composerContentWidth(columns: number, outerPadding: number): number {
  const cols = Math.max(1, Math.floor(columns));
  const pad = Math.max(0, Math.floor(outerPadding));
  return Math.max(1, cols - pad * 2);
}

export function responsivePickerLayout(
  terminalRows: number,
  modeOptionCount: number,
  allowDescriptions = true,
  allowHints = true,
): TuiResponsivePickerLayout {
  const rows = Math.max(1, Math.floor(terminalRows));
  const optionCount = Math.max(1, Math.floor(modeOptionCount));
  const showContext = rows >= 15;
  const showDescriptions = allowDescriptions && rows >= 20;
  const showHints = allowHints && rows >= 17;
  const verticalPadding = showDescriptions ? 1 : 0;
  const borderRows = 2;
  const titleRows = 1;
  const contextRows = showContext ? 1 : 0;
  const hintRows = showHints ? 1 : 0;
  const itemRows = showDescriptions ? 2 : 1;
  const structuralRows = borderRows
    + (verticalPadding * 2)
    + titleRows
    + contextRows
    + hintRows;

  return {
    showContext,
    showDescriptions,
    showHints,
    verticalPadding,
    modePanelRows: structuralRows + (optionCount * itemRows),
    commandMaxVisible: Math.max(1, Math.floor((rows - structuralRows) / itemRows)),
  };
}
