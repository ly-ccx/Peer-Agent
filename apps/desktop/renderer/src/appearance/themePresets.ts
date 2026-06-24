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
  CustomColors,
} from './appearanceTypes';
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_DIFF_MARKER_MODE } from './appearanceTypes';
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

/**
 * custom palette 的默认三色（浅/深各一套）。
 * 取 Peer Frost 的核心三色锚点作为初值，保证用户首次切到 custom 时观感与 frost 接近，
 * 再在此基础上自定义。必须与 paletteRegistry 中 custom 记录的 swatches 保持一致。
 */
export const DEFAULT_CUSTOM_COLORS: CustomColors = {
  light: {
    accent: '#3B7FAB',
    background: '#EDF1F6',
    foreground: '#1A1D21',
  },
  dark: {
    accent: '#5D9CBF',
    background: '#11141A',
    foreground: '#EDF1F6',
  },
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  mode: 'system',
  palette: 'frost',
  density: 'comfortable',
  fontScale: 'medium',
  customColors: DEFAULT_CUSTOM_COLORS,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  diffMarkerMode: DEFAULT_DIFF_MARKER_MODE,
};

/** 单个色板项：展示名 + 十六进制色值（从注册表 re-export）。 */
export type { SwatchEntry } from './paletteRegistry';

/**
 * 各 palette 在浅/深下的真实色板，从配色注册表派生（唯一数据源）。
 * 用于「外观」面板展示当前配色的具体颜色配置项。新增配色无需改这里。
 */
// Object.fromEntries 的返回类型过宽，且 swatches 仍是 as const 字面量，
// 与目标 Record 不充分重叠（TS2352）。先经 unknown 再断言到目标形状。
export const PALETTE_SWATCHES: Readonly<
  Record<AppearancePalette, Readonly<Record<AppearanceScheme, readonly { label: string; value: string }[]>>>
> = Object.fromEntries(
  PALETTE_REGISTRY.map((p) => [p.id, p.swatches]),
) as unknown as Readonly<
  Record<AppearancePalette, Readonly<Record<AppearanceScheme, readonly { label: string; value: string }[]>>>
>;
