import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type {
  AppearanceDensity,
  AppearanceFontScale,
  AppearanceMode,
  AppearancePalette,
  AppearanceScheme,
  AppearanceSettings,
  DiffMarkerMode,
} from './appearanceTypes';
import { DEFAULT_APPEARANCE_SETTINGS } from './themePresets';
import { applyAppearance, sanitizeSettings } from './themeTokens';

const STORAGE_KEY = 'peer-agent.appearance.v2';
const LEGACY_STORAGE_KEY = 'peer-agent.appearance.v1';

interface AppearanceContextValue {
  readonly activeScheme: AppearanceScheme;
  readonly settings: AppearanceSettings;
  readonly setMode: (mode: AppearanceMode) => void;
  readonly setPalette: (palette: AppearancePalette) => void;
  readonly setDensity: (density: AppearanceDensity) => void;
  readonly setFontScale: (fontScale: AppearanceFontScale) => void;
  readonly setCodeFontSize: (size: number) => void;
  readonly setDiffMarkerMode: (mode: DiffMarkerMode) => void;
  readonly reset: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readSystemScheme(): AppearanceScheme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function loadSettings(): AppearanceSettings {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE_SETTINGS;
  const api = window.peerAgent;
  // 1) 优先读主进程同步注入的初始设置——与 ~/.peer-agent/settings.json 同源，
  //    保证刷新/重启后主题立刻正确，无 localStorage 往返、无闪烁
  const stored = api?.initialSettings?.appearance;
  if (stored && typeof stored === 'object') return sanitizeSettings(stored);
  // 2) 一次性迁移旧 Chromium localStorage（v2 → v1）到统一设置，迁完清掉 localStorage
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY);
    if (rawV2) {
      const migrated = sanitizeSettings(JSON.parse(rawV2));
      window.localStorage.removeItem(STORAGE_KEY);
      void api?.updateSettings({ appearance: migrated });
      return migrated;
    }
    /**
     * 从 v1（旧 derive 主题系统）迁移：只保留 mode，丢弃 accent/background/foreground/contrast/translucentSidebar
     * Vellum 是钦定语言，旧自定义主题不再适用。
     */
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as { mode?: unknown };
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      const migrated = sanitizeSettings({ mode: legacy.mode, density: 'comfortable' });
      void api?.updateSettings({ appearance: migrated });
      return migrated;
    }
    return DEFAULT_APPEARANCE_SETTINGS;
  } catch {
    return DEFAULT_APPEARANCE_SETTINGS;
  }
}

function saveSettings(settings: AppearanceSettings) {
  if (typeof window === 'undefined') return;
  // 落 ~/.peer-agent/settings.json（异步 IPC）；不再写 Chromium localStorage
  void window.peerAgent?.updateSettings({ appearance: settings });
}

function appearanceEqual(a: AppearanceSettings, b: AppearanceSettings): boolean {
  return (
    a.mode === b.mode
    && a.palette === b.palette
    && a.density === b.density
    && a.fontScale === b.fontScale
    && a.codeFontSize === b.codeFontSize
    && a.diffMarkerMode === b.diffMarkerMode
  );
}

export function AppearanceProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [settings, setSettings] = useState<AppearanceSettings>(() => loadSettings());
  const [systemScheme, setSystemScheme] = useState<AppearanceScheme>(() => readSystemScheme());
  const activeScheme: AppearanceScheme = settings.mode === 'system' ? systemScheme : settings.mode;

  // Apply tokens only. Never save here — updateSettings broadcasts appearance:changed,
  // which would re-enter setSettings and thrash light/dark (especially mode=system).
  useEffect(() => {
    applyAppearance(settings, activeScheme);
  }, [activeScheme, settings]);

  // Main window / settings may change appearance while Quick Chat is open.
  // Main process broadcasts `appearance:changed` to all windows.
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.peerAgent : undefined;
    if (!api?.onAppearanceChanged) return undefined;
    return api.onAppearanceChanged((next) => {
      if (!next || typeof next !== 'object') return;
      const sanitized = sanitizeSettings(next);
      setSettings((current) => (appearanceEqual(current, sanitized) ? current : sanitized));
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const next = media.matches ? 'dark' : 'light';
      setSystemScheme((current) => (current === next ? current : next));
    };
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const update = useCallback((patch: Partial<AppearanceSettings>) => {
    setSettings((current) => {
      const next = sanitizeSettings({ ...current, ...patch });
      if (appearanceEqual(current, next)) return current;
      // User-initiated only: persist + broadcast via main process.
      saveSettings(next);
      return next;
    });
  }, []);

  const setMode = useCallback((mode: AppearanceMode) => update({ mode }), [update]);
  const setPalette = useCallback((palette: AppearancePalette) => update({ palette }), [update]);
  const setDensity = useCallback((density: AppearanceDensity) => update({ density }), [update]);
  const setFontScale = useCallback((fontScale: AppearanceFontScale) => update({ fontScale }), [update]);
  const setCodeFontSize = useCallback((size: number) => update({ codeFontSize: size }), [update]);
  const setDiffMarkerMode = useCallback((mode: DiffMarkerMode) => update({ diffMarkerMode: mode }), [update]);
  const reset = useCallback(() => {
    setSettings((current) => {
      if (appearanceEqual(current, DEFAULT_APPEARANCE_SETTINGS)) return current;
      saveSettings(DEFAULT_APPEARANCE_SETTINGS);
      return DEFAULT_APPEARANCE_SETTINGS;
    });
  }, []);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      activeScheme,
      settings,
      setMode,
      setPalette,
      setDensity,
      setFontScale,
      setCodeFontSize,
      setDiffMarkerMode,
      reset,
    }),
    [
      activeScheme,
      settings,
      setMode,
      setPalette,
      setDensity,
      setFontScale,
      setCodeFontSize,
      setDiffMarkerMode,
      reset,
    ],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error('useAppearance must be used inside AppearanceProvider');
  }
  return value;
}
