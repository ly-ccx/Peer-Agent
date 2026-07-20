/**
 * Peer Vellum 不再做 token 派生；token 全部固化在 styles/tokens.css。
 * 本文件保留：
 *   - applyAppearance()：把 mode/density/fontScale/diffMarker 写到 <html dataset>，
 *     把 codeFontSize 注入为 <html style 上的 CSS 变量。
 *   - sanitizeSettings()：normalize loadSettings() 读到的 payload；
 *     非法 palette（含历史 custom）回退默认 Frost。
 */

import type {
  AppearanceDensity,
  AppearanceFontScale,
  AppearanceMode,
  AppearanceScheme,
  AppearanceSettings,
  CustomColors,
  CustomSchemeColors,
  DiffMarkerMode,
} from './appearanceTypes';
import { CODE_FONT_SIZE_MAX, CODE_FONT_SIZE_MIN } from './appearanceTypes';
import { DEFAULT_APPEARANCE_SETTINGS, DEFAULT_CUSTOM_COLORS } from './themePresets';
import { sanitizePalette } from './paletteRegistry';

function isMode(value: unknown): value is AppearanceMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isDensity(value: unknown): value is AppearanceDensity {
  return value === 'comfortable' || value === 'compact';
}

function isFontScale(value: unknown): value is AppearanceFontScale {
  return value === 'small' || value === 'medium' || value === 'large';
}

function isDiffMarkerMode(value: unknown): value is DiffMarkerMode {
  return value === 'color' || value === 'sign';
}

// 仅接受 #RGB / #RRGGBB 形式的十六进制颜色，避免注入任意 CSS 造成样式越权。
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim());
}

function sanitizeSchemeColors(
  raw: unknown,
  fallback: CustomSchemeColors,
): CustomSchemeColors {
  const c = (raw ?? {}) as Partial<CustomSchemeColors>;
  return {
    accent: isHexColor(c.accent) ? c.accent.trim() : fallback.accent,
    background: isHexColor(c.background) ? c.background.trim() : fallback.background,
    foreground: isHexColor(c.foreground) ? c.foreground.trim() : fallback.foreground,
  };
}

function sanitizeCustomColors(raw: unknown): CustomColors {
  const c = (raw ?? {}) as Partial<CustomColors>;
  return {
    light: sanitizeSchemeColors(c.light, DEFAULT_CUSTOM_COLORS.light),
    dark: sanitizeSchemeColors(c.dark, DEFAULT_CUSTOM_COLORS.dark),
  };
}

// codeFontSize 限制在 [MIN, MAX] 区间，非数字/越界回退默认。
function sanitizeCodeFontSize(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE_SETTINGS.codeFontSize;
  const rounded = Math.round(n);
  return Math.min(CODE_FONT_SIZE_MAX, Math.max(CODE_FONT_SIZE_MIN, rounded));
}

export function sanitizeSettings(raw: unknown): AppearanceSettings {
  if (!raw || typeof raw !== 'object') return DEFAULT_APPEARANCE_SETTINGS;
  const candidate = raw as Partial<AppearanceSettings>;
  return {
    mode: isMode(candidate.mode) ? candidate.mode : DEFAULT_APPEARANCE_SETTINGS.mode,
    // palette 合法性由配色注册表统一判定；历史 custom 等非法值回退默认 Frost
    palette: sanitizePalette(candidate.palette),
    density: isDensity(candidate.density) ? candidate.density : DEFAULT_APPEARANCE_SETTINGS.density,
    fontScale: isFontScale(candidate.fontScale)
      ? candidate.fontScale
      : DEFAULT_APPEARANCE_SETTINGS.fontScale,
    customColors: sanitizeCustomColors(candidate.customColors),
    codeFontSize: sanitizeCodeFontSize(candidate.codeFontSize),
    diffMarkerMode: isDiffMarkerMode(candidate.diffMarkerMode)
      ? candidate.diffMarkerMode
      : DEFAULT_APPEARANCE_SETTINGS.diffMarkerMode,
  };
}

export function applyAppearance(settings: AppearanceSettings, scheme: AppearanceScheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = scheme;
  root.dataset.themeMode = settings.mode;
  root.dataset.palette = settings.palette;
  root.dataset.density = settings.density;
  root.dataset.fontScale = settings.fontScale;
  root.dataset.diffMarker = settings.diffMarkerMode;
  root.style.setProperty('--za-code-font-size', `${settings.codeFontSize}px`);
  // 自定义配色入口已移除：清理历史 custom 注入变量，避免脏状态残留
  root.style.removeProperty('--za-custom-accent');
  root.style.removeProperty('--za-custom-bg');
  root.style.removeProperty('--za-custom-fg');
}
