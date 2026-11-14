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

import { mkdirSync, writeFileSync } from 'node:fs';
import { loadMigratedSettings } from '@peer-agent/runtime-node';
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
 * Canonical Frost 2.0 dark palette — aligned with Desktop cold obsidian slate
 * and glacial azure accents.
 */
export const DARK_PALETTE: TuiPalette = Object.freeze({
  background: '#10141B',
  panel: '#171C25',
  panelRaised: '#1E2430',
  userPanel: '#232A38',
  selection: '#1D2E3F',
  textSelectionBackground: '#76B0D4',
  textSelectionForeground: '#10141B',
  // The composer belongs to the canvas rather than a separate input card.
  inputBackground: '#10141B',
  inputForeground: '#EEF2F7',
  inputPlaceholder: '#8C98A9',
  inputSelectionBackground: '#76B0D4',
  inputSelectionForeground: '#10141B',
  inputCursor: '#76B0D4',
  border: '#27303E',
  borderFocus: '#76B0D4',

  text: '#EEF2F7',
  textSoft: '#B2BCCB',
  muted: '#8C98A9',
  subtle: '#6A7586',
  dim: '#4A5362',

  accent: '#76B0D4',
  accentSoft: '#96C7E5',
  link: '#76B0D4',
  brandHighlight: '#EEF2F7',
  user: '#96C7E5',
  info: '#96C7E5',

  success: '#63B39D',
  warning: '#E0B268',
  danger: '#D97C92',
  dangerSoft: '#E59AA9',

  tool: '#63B39D',
  toolFailed: '#D97C92',
  toolRunning: '#76A5D6',
  toolCancelled: '#8C98A9',
  toolDetail: '#8C98A9',

  code: '#96C7E5',
  codeBackground: '#171C25',
  diffAdd: '#63B39D',
  diffDelete: '#D97C92',
  diffHunk: '#96C7E5',
  diffMeta: '#8C98A9',
});

/**
 * Frost 2.0 light palette — mapped from desktop tokens.css light scheme:
 * chrome-canvas / paper-base / paper-sheet / graphite / glacial azure.
 */
export const LIGHT_PALETTE: TuiPalette = Object.freeze({
  background: '#EFF3F8', // --chrome-canvas
  panel: '#F7F9FC', // --paper-base
  panelRaised: '#FCFDFF', // --paper-sheet
  userPanel: '#E8EEF6', // --paper-hover
  selection: '#E1ECF4', // --azure-trace
  textSelectionBackground: '#286891',
  textSelectionForeground: '#FCFDFF',
  // Match the light canvas so the composer never becomes a detached white card.
  inputBackground: '#EFF3F8',
  inputForeground: '#181C22',
  inputPlaceholder: '#616A79',
  inputSelectionBackground: '#286891',
  inputSelectionForeground: '#FCFDFF',
  inputCursor: '#286891',
  border: '#DDE4EE', // --chrome-hairline
  borderFocus: '#286891',

  text: '#181C22', // --graphite-base
  textSoft: '#4E5664', // --graphite-soft
  muted: '#616A79', // --graphite-fade
  subtle: '#7B8494',
  dim: '#A4AEBC', // --graphite-mute

  accent: '#286891', // --azure-seal
  accentSoft: '#3B7FAB',
  link: '#286891',
  brandHighlight: '#FCFDFF',
  user: '#286891',
  info: '#32639B', // distinct cool steel-blue from accent

  success: '#296E5D', // --state-success
  warning: '#8E5B1E',
  danger: '#963850', // --state-danger
  dangerSoft: '#B04D66',

  tool: '#296E5D',
  toolFailed: '#963850',
  toolRunning: '#32639B',
  toolCancelled: '#616A79',
  toolDetail: '#616A79',

  code: '#286891',
  codeBackground: '#EAEFF5', // --paper-sunken
  diffAdd: '#296E5D',
  diffDelete: '#963850',
  diffHunk: '#32639B',
  diffMeta: '#616A79',
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

  const readSettings = (): Record<string, unknown> => loadMigratedSettings(settingsFile);

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
