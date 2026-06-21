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
  // 1) 首选 ~/.peer-agent/settings.json 的首屏同步快照（preload 注入），无 IPC 往返、无闪烁
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

export function AppearanceProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [settings, setSettings] = useState<AppearanceSettings>(() => loadSettings());
  const [systemScheme, setSystemScheme] = useState<AppearanceScheme>(() => readSystemScheme());
  const activeScheme: AppearanceScheme = settings.mode === 'system' ? systemScheme : settings.mode;

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemScheme(readSystemScheme());
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    saveSettings(settings);
    applyAppearance(activeScheme, settings);
  }, [activeScheme, settings]);

  const setMode = useCallback((mode: AppearanceMode) => {
    setSettings((current) => ({ ...current, mode }));
  }, []);

  const setPalette = useCallback((palette: AppearancePalette) => {
    setSettings((current) => ({ ...current, palette }));
  }, []);

  const setDensity = useCallback((density: AppearanceDensity) => {
    setSettings((current) => ({ ...current, density }));
  }, []);

  const setFontScale = useCallback((fontScale: AppearanceFontScale) => {
    setSettings((current) => ({ ...current, fontScale }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_APPEARANCE_SETTINGS), []);

  const value = useMemo<AppearanceContextValue>(() => ({
    activeScheme,
    settings,
    setMode,
    setPalette,
    setDensity,
    setFontScale,
    reset,
  }), [activeScheme, reset, setDensity, setFontScale, setMode, setPalette, settings]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) {
    throw new Error('useAppearance must be used inside AppearanceProvider');
  }
  return value;
}
