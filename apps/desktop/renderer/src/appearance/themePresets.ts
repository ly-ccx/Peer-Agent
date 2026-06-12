/**
 * Peer Frost 是 Peer Agent 桌面端的默认设计语言。
 *
 * 此文件保留：
 *   - DEFAULT_APPEARANCE_SETTINGS：第一次启动的默认值
 *   - DESIGN_SYSTEM_NAME：默认设计语言名（展示用）
 *   - PALETTE_LABELS：palette → 展示名映射
 *   - PEER_FROST_TOKENS：浅/深两套快照，仅供测试断言/导出使用
 *
 * 真正的 token 值落在 styles/tokens.css，本文件只作语义副本。
 */

import type {
  AppearancePalette,
  AppearanceSettings,
  AppearanceScheme,
} from './appearanceTypes';
import { PALETTE_REGISTRY } from './paletteRegistry';

export const DESIGN_SYSTEM_NAME = 'Peer Frost';

// 从配色注册表派生：palette → 展示名。新增配色无需改这里。
export const PALETTE_LABELS: Readonly<Record<AppearancePalette, string>> =
  Object.fromEntries(
    PALETTE_REGISTRY.map((p) => [p.id, p.label]),
  ) as Readonly<Record<AppearancePalette, string>>;

export interface ThemeSnapshot {
  readonly scheme: AppearanceScheme;
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
}

/**
 * Peer Frost 视觉契约的核心三色锚点（与 tokens.css 一致）。
 * 仅用于：1. 测试断言（验证锚点未漂移）2. 导出/分享识别。
 */
export const PEER_FROST_TOKENS: Readonly<Record<AppearanceScheme, ThemeSnapshot>> = {
  light: {
    scheme: 'light',
    accent: '#3B7FAB',     // azure-seal
    background: '#F4F6F9', // paper-base (light)
    foreground: '#1A1D21', // graphite-base
  },
  dark: {
    scheme: 'dark',
    accent: '#5D9CBF',     // azure-seal (dark)
    background: '#16191D',
    foreground: '#EDF1F6',
  },
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  mode: 'system',
  palette: 'frost',
  density: 'comfortable',
};

/** 单个色板项：展示名 + 十六进制色值（从注册表 re-export）。 */
export type { SwatchEntry } from './paletteRegistry';

/**
 * 各 palette 在浅/深下的真实色板，从配色注册表派生（唯一数据源）。
 * 用于「外观」面板展示当前配色的具体颜色配置项。新增配色无需改这里。
 */
export const PALETTE_SWATCHES: Readonly<
  Record<AppearancePalette, Readonly<Record<AppearanceScheme, readonly { label: string; value: string }[]>>>
> = Object.fromEntries(
  PALETTE_REGISTRY.map((p) => [p.id, p.swatches]),
) as Readonly<
  Record<AppearancePalette, Readonly<Record<AppearanceScheme, readonly { label: string; value: string }[]>>>
>;
