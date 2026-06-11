/**
 * Peer Vellum 不再做 token 派生；token 全部固化在 styles/tokens.css。
 * 本文件只保留：
 *   - applyAppearance()：把 mode/density 写到 <html dataset>，让 CSS 切换生效
 *   - sanitizeSettings()：normalize loadSettings() 读到的 localStorage payload
 */

import type {
  AppearanceDensity,
  AppearanceMode,
  AppearanceScheme,
  AppearanceSettings,
} from './appearanceTypes';
import { DEFAULT_APPEARANCE_SETTINGS } from './themePresets.ts';
import { sanitizePalette } from './paletteRegistry';

function isMode(value: unknown): value is AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isDensity(value: unknown): value is AppearanceDensity {
  return value === 'comfortable' || value === 'compact';
}

export function sanitizeSettings(raw: unknown): AppearanceSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE_SETTINGS;
  const candidate = raw as Partial<AppearanceSettings>;
  return {
    mode: isMode(candidate.mode) ? candidate.mode : DEFAULT_APPEARANCE_SETTINGS.mode,
    // palette 合法性由配色注册表统一判定，新增配色自动生效
    palette: sanitizePalette(candidate.palette),
    density: isDensity(candidate.density) ? candidate.density : DEFAULT_APPEARANCE_SETTINGS.density,
  };
}

export function applyAppearance(scheme: AppearanceScheme, settings: AppearanceSettings) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = scheme;
  root.dataset.themeMode = settings.mode;
  root.dataset.palette = settings.palette;
  root.dataset.density = settings.density;
  root.style.colorScheme = scheme;
}
