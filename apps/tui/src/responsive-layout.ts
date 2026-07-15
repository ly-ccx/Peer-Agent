export type TuiLayoutDensity = 'wide' | 'compact' | 'narrow' | 'minimal';

export interface TuiResponsiveLayout {
  readonly density: TuiLayoutDensity;
  readonly showDescriptions: boolean;
  readonly showHints: boolean;
  readonly stackActions: boolean;
  readonly outerPadding: number;
  readonly welcomeWidth: `${number}%`;
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
