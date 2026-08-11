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
  /** Selected menu/list item background. */
  readonly selection: string;
  /** Mouse/keyboard text selection, always supplied as a foreground/background pair. */
  readonly textSelectionBackground: string;
  readonly textSelectionForeground: string;
  /** Editable text interaction states. */
  readonly inputBackground: string;
  readonly inputForeground: string;
  readonly inputPlaceholder: string;
  readonly inputSelectionBackground: string;
  readonly inputSelectionForeground: string;
  readonly inputCursor: string;
  readonly border: string;
  readonly borderFocus: string;
  readonly text: string;
  readonly textSoft: string;
  readonly muted: string;
  readonly subtle: string;
  readonly dim: string;
  readonly accent: string;
  readonly accentSoft: string;
  /** Interactive link foreground. */
  readonly link: string;
  /** Bright endpoint for branded glow/gradient effects. */
  readonly brandHighlight: string;
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
 * Canonical dark palette — mirrors peer-tui-crush.html semantic tokens.
 * Surfaces establish depth; ice identifies people/information; lime is reserved
 * for focus and primary interaction; green/amber/red communicate outcomes.
 */
export const DARK_PALETTE: TuiPalette = Object.freeze({
  background: '#080a0c',
  panel: '#0d1013',
  panelRaised: '#12161a',
  userPanel: '#0d1013',
  selection: '#171c21',
  textSelectionBackground: '#b8f35b',
  textSelectionForeground: '#080a0c',
  // The composer belongs to the canvas rather than a separate input card.
  inputBackground: '#080a0c',
  inputForeground: '#e7ebee',
  inputPlaceholder: '#69737d',
  inputSelectionBackground: '#b8f35b',
  inputSelectionForeground: '#080a0c',
  inputCursor: '#b8f35b',
  border: '#20262c',
  borderFocus: '#3e4851',

  text: '#e7ebee',
  textSoft: '#b8c0c7',
  muted: '#69737d',
  subtle: '#56616b',
  dim: '#3e4851',

  accent: '#b8f35b',
  accentSoft: '#d0fa8e',
  link: '#a9d9e8',
  brandHighlight: '#ffffff',
  user: '#a9d9e8',
  info: '#a9d9e8',

  success: '#68d391',
  warning: '#e6b86a',
  danger: '#ef7373',
  dangerSoft: '#f59a9a',

  tool: '#68d391',
  toolFailed: '#ef7373',
  toolRunning: '#e6b86a',
  toolCancelled: '#69737d',
  toolDetail: '#69737d',

  code: '#b8f35b',
  codeBackground: '#12161a',
  diffAdd: '#68d391',
  diffDelete: '#ef7373',
  diffHunk: '#a9d9e8',
  diffMeta: '#69737d',
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
  textSelectionBackground: '#1E3A5F',
  textSelectionForeground: '#FFFFFF',
  // Match the light canvas so the composer never becomes a detached white card.
  inputBackground: '#F3F5F8',
  inputForeground: '#1A2332',
  inputPlaceholder: '#6B7585',
  inputSelectionBackground: '#1E3A5F',
  inputSelectionForeground: '#FFFFFF',
  inputCursor: '#4D7C0F',
  border: '#DCE0E8', // --chrome-hairline
  borderFocus: '#C8CEDA',

  text: '#1A2332', // --graphite-ink
  textSoft: '#2A3548', // --graphite-body
  muted: '#6B7585', // --graphite-mute
  subtle: '#8B93A1', // --graphite-faint
  dim: '#A8B0BC',

  accent: '#4D7C0F', // deep lime on light
  accentSoft: '#65A30D',
  link: '#2563EB',
  brandHighlight: '#FFFFFF',
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

/**
 * Shared picker language — a terminal layer, not a floating card.
 *
 * One quiet separator establishes hierarchy. Selection is carried by the thin
 * caret and accent text; rows intentionally keep the canvas background so a
 * full-width highlight never becomes a second panel.
 */
export const PICKER_CHROME = {
  caretSelected: '› ',
  caretIdle: '  ',
  checkCurrent: ' ✓',
  separator: '─',
  hintSeparator: ' · ',
  get selectedBackground() { return COLOR.background; },
  get idleBackground() { return COLOR.background; },
  get selectedForeground() { return COLOR.accent; },
  get idleForeground() { return COLOR.text; },
  get mutedForeground() { return COLOR.muted; },
  get border() { return COLOR.border; },
  get title() { return COLOR.info; },
  get warning() { return COLOR.warning; },
  get danger() { return COLOR.dangerSoft; },
} as const;

/**
 * Markdown chrome glyphs.
 * h2 uses the same thin caret as design figure-2 / picker (`›`), not a filled triangle.
 */
export const MARKDOWN_CHROME = {
  headingH1: '▌ ',
  headingH2: '› ',
  headingH3: '• ',
  listBullet: '• ',
  quotePrefix: '│ ',
} as const;

/** Session / app chrome glyphs (topbar, user rail, enable dots). */
export const APP_CHROME = {
  brandMark: '◆',
  onlineDot: '●',
  offlineDot: '○',
  userRailBar: '▌ ',
} as const;

/** Goal task status glyphs. */
export const GOAL_CHROME = {
  glyphCompleted: '✓',
  glyphRunning: '▶',
  glyphFailed: '!',
  glyphCancelled: '–',
  glyphPending: '○',
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
  glyphRunningPulse: '◆',
  glyphUnknown: '·',
  /** Soft pulse frames around the design-running glyph (◇). */
  runningFrames: ['◇', '◆', '◇', '◆'] as const,
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

export type TuiThemeChangeListener = (state: TuiThemeState) => void;

export type TuiThemeStore = {
  readonly getState: () => TuiThemeState;
  readonly getMode: () => TuiThemeMode;
  readonly getScheme: () => TuiThemeScheme;
  readonly setMode: (mode: TuiThemeMode) => TuiThemeState;
  /**
   * Subscribe to palette/mode changes. System-theme watching starts with the
   * first subscriber and stops when the last one unsubscribes.
   */
  readonly subscribe: (listener: TuiThemeChangeListener) => () => void;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}


export type SystemThemeWatcherOptions = {
  readonly getMode: () => TuiThemeMode;
  readonly onChange: (state: TuiThemeState) => void;
  readonly intervalMs?: number;
  readonly detectPrefersDark?: () => boolean;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
};

/**
 * Poll system appearance while mode === 'system' and re-apply COLOR when it
 * flips. Terminal hosts have no reliable appearance-change event, so a light
 * poll keeps open TUI sessions in sync with OS auto light/dark switches.
 */
export function startSystemThemeWatcher(options: SystemThemeWatcherOptions): () => void {
  const intervalMs = options.intervalMs ?? 3000;
  const detectPrefersDark = options.detectPrefersDark ?? (() => detectSystemPrefersDark());
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  let lastPrefersDark = detectPrefersDark();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    if (options.getMode() !== 'system') return;

    const prefersDark = detectPrefersDark();
    if (prefersDark === lastPrefersDark) return;
    lastPrefersDark = prefersDark;
    options.onChange(applyThemeMode('system', prefersDark));
  };

  const timer = setIntervalFn(tick, intervalMs);
  return () => {
    stopped = true;
    clearIntervalFn(timer);
  };
}

/**
 * Persist theme mode in the same settings.json as locale
 * (`~/.peer-agent/settings.json` via host userDataPath).
 */
export type TuiThemeStoreOptions = {
  readonly userDataPath: string;
  /**
   * System-theme watch config. Pass `false` to disable (tests).
   * Watching is lazy: starts with first subscribe(), stops on last unsubscribe.
   */
  readonly systemThemeWatch?: false | {
    readonly intervalMs?: number;
    readonly detectPrefersDark?: () => boolean;
    readonly setIntervalFn?: typeof setInterval;
    readonly clearIntervalFn?: typeof clearInterval;
  };
};

export function createTuiThemeStore({
  userDataPath,
  systemThemeWatch,
}: TuiThemeStoreOptions): TuiThemeStore {
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

  // Cache the scheme that was actually applied. In system mode this is the
  // watcher-updated source of truth; re-detecting the OS in getScheme() can
  // disagree with an injected watcher and with the live COLOR palette.
  const initial = readState();
  let currentState = applyThemeMode(initial.mode);

  const listeners = new Set<TuiThemeChangeListener>();
  let stopWatcher: (() => void) | null = null;

  const notify = (state: TuiThemeState): void => {
    currentState = state;
    for (const listener of listeners) listener(state);
  };

  const getMode = (): TuiThemeMode => normalizeTuiThemeMode(readSettings().themeMode, activeMode);

  const ensureWatcher = (): void => {
    if (systemThemeWatch === false || stopWatcher) return;
    const watch = systemThemeWatch === undefined ? {} : systemThemeWatch;
    stopWatcher = startSystemThemeWatcher({
      getMode,
      onChange: notify,
      intervalMs: watch.intervalMs,
      detectPrefersDark: watch.detectPrefersDark,
      setIntervalFn: watch.setIntervalFn,
      clearIntervalFn: watch.clearIntervalFn,
    });
  };

  const maybeStopWatcher = (): void => {
    if (listeners.size > 0 || !stopWatcher) return;
    stopWatcher();
    stopWatcher = null;
  };

  return {
    getState: () => ({ mode: getMode(), scheme: currentState.scheme }),
    getMode,
    getScheme: () => currentState.scheme,
    setMode(mode) {
      const nextMode = normalizeTuiThemeMode(mode, 'dark');
      writeSettings({
        ...readSettings(),
        themeMode: nextMode,
      });
      const next = applyThemeMode(nextMode);
      notify(next);
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      ensureWatcher();
      return () => {
        listeners.delete(listener);
        maybeStopWatcher();
      };
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
