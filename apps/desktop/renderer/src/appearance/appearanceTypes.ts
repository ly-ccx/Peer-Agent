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

export interface AppearanceSettings {
  readonly mode: AppearanceMode;
  readonly palette: AppearancePalette;
  readonly density: AppearanceDensity;
  readonly fontScale: AppearanceFontScale;
}
