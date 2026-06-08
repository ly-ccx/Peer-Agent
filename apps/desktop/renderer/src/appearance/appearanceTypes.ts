/**
 * Atlas Vellum 设计语言下，主题不再是"用户可调旋钮"，
 * 而是固定的设计语言契约。Appearance 仅暴露：
 *   - mode: 浅 / 深 / 跟随系统
 *   - density: 宽松 / 紧凑（Phase 2 启用 UI）
 *
 * 朱砂 / 墨 / 羊皮纸 三层 token 在 styles/tokens.css 中固化，
 * 不允许通过 Appearance API 修改（红线 §6）。
 */

export type AppearanceMode = 'light' | 'dark' | 'system';

export type AppearanceScheme = 'light' | 'dark';

export type AppearanceDensity = 'comfortable' | 'compact';

export interface AppearanceSettings {
  readonly mode: AppearanceMode;
  readonly density: AppearanceDensity;
}
