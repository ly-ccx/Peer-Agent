/**
 * Unified TUI visual system — Peer Frost aligned.
 *
 * Desktop owns full Appearance (mode + palette + density). TUI mirrors the
 * Frost light/dark surface language so terminal sessions feel like the same
 * product, while keeping a compact terminal-friendly accent system.
 *
 * `COLOR` is a live mutable palette: callers import it once; switching theme
 * rewrites the same object so chrome updates without rewiring every import.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

export type TuiThemeScheme = 'light' | 'dark';
export type TuiThemeMode = 'light' | 'dark' | 'system';

export type TuiPalette = {
  readonly background: string;
  readonly panel: string;
  readonly panelRaised: string;
  readonly userPanel: string;
  readonly selection: string;
  readonly border: string;
  readonly borderFocus: string;
  readonly text: string;
  readonly textSoft: string;
  readonly muted: string;
  readonly subtle: string;
  readonly dim: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly user: string;
  readonly info: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly tool: string;
  readonly toolFailed: string;
  readonly toolRunning: string;
  readonly toolCancelled: string;
  readonly toolDetail: string;
  readonly code: string;
  readonly codeBackground: string;
  readonly diffAdd: string;
  readonly diffDelete: string;
  readonly diffHunk: string;
  readonly diffMeta: string;
};

/** Mutable palette type for runtime theme switching. */
type MutablePalette = {
  -readonly [K in keyof TuiPalette]: TuiPalette[K];
};

/**
 * Frost dark — terminal-tuned surfaces close to desktop dark chrome,
 * with TUI lime accent retained for mode / status readability.
 */
export const DARK_PALETTE: TuiPalette = Object.freeze({
  background: '#0a0a0a',
  panel: '#111111',
  panelRaised: '#161616',
  userPanel: '#10212a',
  selection: '#1c1c1c',
  border: '#2a2a2a',
  borderFocus: '#3f3f46',

  text: '#e5e5e5',
  textSoft: '#d4d4d4',
  muted: '#737373',
  subtle: '#525252',
  dim: '#404040',

  accent: '#a3e635',
  accentSoft: '#bef264',
  user: '#7dd3fc',
  info: '#7189c9',

  success: '#86efac',
  warning: '#fbbf24',
  danger: '#fb7185',
  dangerSoft: '#fca5a5',

  tool: '#86efac',
  toolFailed: '#fb7185',
  toolRunning: '#fde68a',
  toolCancelled: '#a3a3a3',
  toolDetail: '#a3a3a3',

  code: '#bef264',
  codeBackground: '#171717',
  diffAdd: '#4ade80',
  diffDelete: '#f87171',
  diffHunk: '#67e8f9',
  diffMeta: '#737373',
});

/**
 * Frost light — mapped from desktop tokens.css light scheme:
 * chrome-base / paper-sheet / graphite / state colors.
 * Accent uses a deeper lime so it stays readable on white paper.
 */
export const LIGHT_PALETTE: TuiPalette = Object.freeze({
  background: '#F3F5F8', // --chrome-base
  panel: '#FFFFFF', // --chrome-panel
  panelRaised: '#F7F9FC', // --paper-sheet
  userPanel: '#E8F1FF', // soft user blue
  selection: '#E8EEF7', // --chrome-hover-ish
  border: '#DCE0E8', // --chrome-hairline
  borderFocus: '#C8CEDA',

  text: '#1A2332', // --graphite-ink
  textSoft: '#2A3548', // --graphite-body
  muted: '#6B7585', // --graphite-mute
  subtle: '#8B93A1', // --graphite-faint
  dim: '#A8B0BC',

  accent: '#4D7C0F', // deep lime on light
  accentSoft: '#65A30D',
  user: '#2563EB', // azure-ish user
  info: '#4F7CFF', // --azure-seal

  success: '#1A8F4A', // --state-success
  warning: '#B45309', // --state-warning
  danger: '#C23B3B', // --state-danger
  dangerSoft: '#DC6B6B',

  tool: '#1A8F4A',
  toolFailed: '#C23B3B',
  toolRunning: '#B45309',
  toolCancelled: '#8B93A1',
  toolDetail: '#6B7585',

  code: '#3F6212',
  codeBackground: '#EBEEF3', // --chrome-sunken
  diffAdd: '#1A8F4A',
  diffDelete: '#C23B3B',
  diffHunk: '#2563EB',
  diffMeta: '#6B7585',
});

export const THEME_PALETTES: Readonly<Record<TuiThemeScheme, TuiPalette>> = Object.freeze({
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
});

/** Live palette — default dark (matches historical TUI). */
export const COLOR: MutablePalette = { ...DARK_PALETTE };

export type TuiColor = string;

let activeScheme: TuiThemeScheme = 'dark';
let activeMode: TuiThemeMode = 'dark';

export function getActiveThemeScheme(): TuiThemeScheme {
  return activeScheme;
}

export function getActiveThemeMode(): TuiThemeMode {
  return activeMode;
}

type SystemThemeDetectionOptions = {
  readonly platform?: NodeJS.Platform;
  readonly colorFgBg?: string;
  readonly readMacOSAppearance?: () => string;
};

export function detectSystemPrefersDark(options: SystemThemeDetectionOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    try {
      const readMacOSAppearance = options.readMacOSAppearance ?? (() => execSync(
        'defaults read -g AppleInterfaceStyle',
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      ));
      return readMacOSAppearance().trim() === 'Dark';
    } catch {
      // In macOS light mode AppleInterfaceStyle is normally absent.
      return false;
    }
  }

  // COLORFGBG is "fg;bg". bg 0–7 ≈ dark, 8–15 ≈ light (xterm convention).
  const cfg = options.colorFgBg ?? process.env.COLORFGBG;
  if (cfg) {
    const bg = Number(cfg.split(';').pop());
    if (Number.isFinite(bg)) return bg < 8;
  }

  // Terminal default: prefer dark (historical TUI look).
  return true;
}

export function resolveThemeScheme(
  mode: TuiThemeMode,
  prefersDark: boolean = detectSystemPrefersDark(),
): TuiThemeScheme {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

export function normalizeTuiThemeMode(
  value: unknown,
  fallback: TuiThemeMode = 'dark',
): TuiThemeMode {
  if (value === 'light' || value === 'dark' || value === 'system') return value;
  return fallback;
}

/** Apply a resolved light/dark scheme onto the shared COLOR object. */
export function applyThemeScheme(scheme: TuiThemeScheme): TuiThemeScheme {
  const palette = THEME_PALETTES[scheme];
  Object.assign(COLOR, palette);
  activeScheme = scheme;
  return scheme;
}

/** Apply a user mode (light/dark/system) and resolve to concrete scheme. */
export function applyThemeMode(
  mode: TuiThemeMode,
  prefersDark: boolean = detectSystemPrefersDark(),
): { readonly mode: TuiThemeMode; readonly scheme: TuiThemeScheme } {
  const scheme = resolveThemeScheme(mode, prefersDark);
  applyThemeScheme(scheme);
  activeMode = mode;
  return { mode, scheme };
}

/** Shared picker chrome — reads live COLOR so theme switches propagate. */
export const PICKER_CHROME = {
  caretSelected: '› ',
  caretIdle: '  ',
  checkCurrent: ' ✓',
  get selectedBackground() { return COLOR.selection; },
  get idleBackground() { return COLOR.panel; },
  get selectedForeground() { return COLOR.accent; },
  get idleForeground() { return COLOR.text; },
  get mutedForeground() { return COLOR.muted; },
  get border() { return COLOR.border; },
  get title() { return COLOR.accent; },
  get warning() { return COLOR.warning; },
  get danger() { return COLOR.dangerSoft; },
} as const;

/** Tool timeline markers and branch characters. */
export const TOOL_CHROME = {
  branchFirst: '  ╰ ',
  branchRest: '    ',
  // Crush design: completed ✓, running ◇; color still carries status tone.
  glyphCompleted: '✓',
  glyphFailed: '✗',
  glyphCancelled: '○',
  glyphRunning: '◇',
  glyphUnknown: '·',
} as const;

export function toolStatusColor(status: string): string {
  switch (status) {
    case 'failed':
    case 'denied':
      return COLOR.toolFailed;
    case 'running':
      return COLOR.toolRunning;
    case 'cancelled':
      return COLOR.toolCancelled;
    case 'completed':
      return COLOR.tool;
    default:
      return COLOR.toolDetail;
  }
}

/**
 * Context usage accent for the status-bar meter.
 * Low usage stays cyan (design), high usage escalates to warning/danger.
 */
export function contextUsageColor(percent: number | undefined, fallback = COLOR.user): string {
  if (percent === undefined) return fallback;
  if (percent >= 90) return COLOR.danger;
  if (percent >= 80) return COLOR.warning;
  return COLOR.user;
}

export type TuiThemeState = {
  readonly mode: TuiThemeMode;
  readonly scheme: TuiThemeScheme;
};

export type TuiThemeStore = {
  readonly getState: () => TuiThemeState;
  readonly getMode: () => TuiThemeMode;
  readonly getScheme: () => TuiThemeScheme;
  readonly setMode: (mode: TuiThemeMode) => TuiThemeState;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Persist theme mode in the same settings.json as locale
 * (`~/.peer-agent/settings.json` via host userDataPath).
 */
export function createTuiThemeStore({
  userDataPath,
}: {
  readonly userDataPath: string;
}): TuiThemeStore {
  const settingsFile = path.join(userDataPath, 'settings.json');

  const readSettings = (): Record<string, unknown> => {
    if (!existsSync(settingsFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as unknown;
      return isObjectRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeSettings = (next: Record<string, unknown>): void => {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
  };

  const readState = (): TuiThemeState => {
    const settings = readSettings();
    const mode = normalizeTuiThemeMode(settings.themeMode, 'dark');
    const scheme = resolveThemeScheme(mode);
    return { mode, scheme };
  };

  // Apply persisted mode on store creation so COLOR matches settings.
  const initial = readState();
  applyThemeMode(initial.mode);

  return {
    getState: () => {
      const mode = normalizeTuiThemeMode(readSettings().themeMode, activeMode);
      return { mode, scheme: resolveThemeScheme(mode) };
    },
    getMode: () => normalizeTuiThemeMode(readSettings().themeMode, activeMode),
    getScheme: () => resolveThemeScheme(normalizeTuiThemeMode(readSettings().themeMode, activeMode)),
    setMode(mode) {
      const nextMode = normalizeTuiThemeMode(mode, 'dark');
      writeSettings({
        ...readSettings(),
        themeMode: nextMode,
      });
      return applyThemeMode(nextMode);
    },
  };
}

export const TUI_THEME_OPTIONS: readonly {
  readonly mode: TuiThemeMode;
  readonly labelZh: string;
  readonly labelEn: string;
}[] = Object.freeze([
  { mode: 'light', labelZh: '浅色', labelEn: 'Light' },
  { mode: 'dark', labelZh: '深色', labelEn: 'Dark' },
  { mode: 'system', labelZh: '跟随系统', labelEn: 'System' },
]);
