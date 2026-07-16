export type TuiLayoutDensity = 'wide' | 'compact' | 'narrow' | 'minimal';

export interface TuiResponsiveLayout {
  readonly density: TuiLayoutDensity;
  readonly showDescriptions: boolean;
  readonly showHints: boolean;
  readonly stackActions: boolean;
  readonly outerPadding: number;
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

export function responsiveLayout(columns: number): TuiResponsiveLayout {
  if (columns >= 120) return {
    density: 'wide', showDescriptions: true, showHints: true,
    stackActions: false, outerPadding: 2, welcomeWidth: '75%',
  };
  if (columns >= 80) return {
    density: 'compact', showDescriptions: true, showHints: true,
    stackActions: false, outerPadding: 1, welcomeWidth: '88%',
  };
  if (columns >= 60) return {
    density: 'narrow', showDescriptions: false, showHints: true,
    stackActions: true, outerPadding: 1, welcomeWidth: '100%',
  };
  return {
    density: 'minimal', showDescriptions: false, showHints: false,
    stackActions: true, outerPadding: 0, welcomeWidth: '100%',
  };
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
