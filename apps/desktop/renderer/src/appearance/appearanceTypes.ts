/**
 * Peer Frost 是 Peer Agent 桌面端的默认设计语言。Appearance 暴露：
 *   - mode: 浅 / 深 / 跟随系统
 *   - palette: 配色方案（frost 默认；catppuccin 为可选第三方调色板）
 *   - density: 宽松 / 紧凑（Phase 2 启用 UI）
 *   - fontScale: 界面字体大小 小 / 中 / 大（驱动根 font-size 百分比缩放，rem 字号跟随）
 *
 * 历史背景（红线 §6 的演化）：
 *   旧 Vellum/Frost 契约把三层 token 完全固化、禁止任何用户调色。
 *   项目主人在 2026-06 显式授权开放一条"正交的配色轴"：
 *   palette 不破坏 light/dark 机制，只在 tokens.css 里追加覆盖块。
 *   frost 仍是默认，保证既有用户零回归。
 */

export type AppearanceMode = 'light' | 'dark' | 'system';

export type AppearanceScheme = 'light' | 'dark';

// palette 的合法集合由配色注册表（paletteRegistry.ts）派生，
// 新增配色只需在注册表加一条记录，类型自动跟随。
// 注意：必须 import 进本模块作用域再 re-export——纯 `export type {…} from`
// 只做转发、不把名字引入本文件，否则下面 AppearanceSettings.palette 会 TS2304。
import type { AppearancePalette } from './paletteRegistry';
export type { AppearancePalette };

export type AppearanceDensity = 'comfortable' | 'compact';

// 界面字体大小：一条正交于 mode/palette/density 的外观轴。
// 通过 <html dataset.fontScale> + tokens.css 根 font-size 百分比缩放生效，
// 全局 rem 字号随之缩放（写死 px 的字号不跟随，属策略 A 的已知取舍）。
export type AppearanceFontScale = 'small' | 'medium' | 'large';

// 代码字号：编辑器/代码块/Diff 视图使用的等宽字号（px）。
// 正交于 fontScale（后者缩放 UI rem 字号，不影响写死 px 的代码字号）。
// 通过 <html style 上的 --za-code-font-size 变量生效。
export type AppearanceCodeFontSize = number;
export const CODE_FONT_SIZE_MIN = 10;
export const CODE_FONT_SIZE_MAX = 24;
export const DEFAULT_CODE_FONT_SIZE = 12;

// 差异标记模式：Diff 视图区分增删行的方式。
//   - color: 仅用背景/前景配色区分（默认）
//   - sign : 额外在行首显示 +/- 符号列（对色弱用户更友好）
export type DiffMarkerMode = 'color' | 'sign';
export const DEFAULT_DIFF_MARKER_MODE: DiffMarkerMode = 'color';

// 单套配色方案下用户自定义的三个语义色（强调 / 背景 / 前景）。
// 仅在 palette='custom' 时生效，运行时注入为 CSS 变量；其余中性色走 tokens.css 兜底骨架。
export interface CustomSchemeColors {
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
}

// 浅 / 深各一套独立自定义三色（对齐 Codex 的"每套主题独立配色"）。
export interface CustomColors {
  readonly light: CustomSchemeColors;
  readonly dark: CustomSchemeColors;
}

export interface AppearanceSettings {
  readonly mode: AppearanceMode;
  readonly palette: AppearancePalette;
  readonly density: AppearanceDensity;
  readonly fontScale: AppearanceFontScale;
  // 自定义三色（浅/深各一套）。仅 palette='custom' 时被运行时注入采用。
  readonly customColors: CustomColors;
  // 代码字号（px）。
  readonly codeFontSize: AppearanceCodeFontSize;
  // Diff 差异标记模式。
  readonly diffMarkerMode: DiffMarkerMode;
}
