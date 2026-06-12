/**
 * 配色注册表（Palette Registry）—— 配色系统的唯一数据源（Single Source of Truth）。
 *
 * 设计目标：新增一个配色只需在本文件 PALETTE_REGISTRY 里加一条记录，
 * 其它所有派生物（类型、展示名、圆点色、色板、面板选项、CSS 列数）全部自动跟随，
 * 不再需要跨 5 个文件手工同步。
 *
 * 一条记录包含一个配色在「外观」面板与运行时所需的全部信息：
 *   - id        : 稳定标识，写入 <html data-palette>，对应 tokens.css 的覆盖块
 *   - label     : 展示名
 *   - dotColor  : 面板选项前的小圆点（CSS color / gradient 字符串）
 *   - swatches  : 浅/深两套真实色板，用于面板底部「具体颜色配置项」展示
 *
 * 注意：真正生效的 token 值仍固化在 styles/tokens.css 的 [data-palette="<id>"] 覆盖块，
 * 本文件的 swatches 是与之一致的展示副本（红线 §6：palette 只追加覆盖、不破坏 light/dark 机制）。
 */

export type AppearanceScheme = 'light' | 'dark';

/** 单个色板项：展示名 + 十六进制色值。 */
export interface SwatchEntry {
  readonly label: string;
  readonly value: string;
}

/** 一个配色在注册表里的完整定义。 */
export interface PaletteDefinition {
  readonly id: string;
  readonly label: string;
  /** 面板选项小圆点的颜色，可为纯色或 linear-gradient 字符串。 */
  readonly dotColor: string;
  readonly swatches: Readonly<Record<AppearanceScheme, readonly SwatchEntry[]>>;
}

/**
 * ⬇️ 唯一需要维护的地方：新增配色就在这里追加一条记录。
 * 顺序即面板里的展示顺序；数组第一项即默认配色的兜底来源。
 */
export const PALETTE_REGISTRY = [
  {
    id: 'frost',
    label: 'Peer Frost',
    dotColor: '#3b7fab',
    swatches: {
      light: [
        { label: 'Accent', value: '#3B7FAB' },
        { label: 'Background', value: '#EDF1F6' },
        { label: 'Surface', value: '#F7F9FC' },
        { label: 'Text', value: '#1A1D21' },
        { label: 'Success', value: '#3E7A6B' },
        { label: 'Warn', value: '#3B6FAB' },
        { label: 'Danger', value: '#7A3E50' },
      ],
      dark: [
        { label: 'Accent', value: '#5D9CBF' },
        { label: 'Background', value: '#11141A' },
        { label: 'Surface', value: '#1E232C' },
        { label: 'Text', value: '#EDF1F6' },
        { label: 'Success', value: '#6EAA9B' },
        { label: 'Warn', value: '#6B9FCB' },
        { label: 'Danger', value: '#AA6E80' },
      ],
    },
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    dotColor: 'linear-gradient(135deg, #8839ef 0%, #1e66f5 100%)',
    swatches: {
      light: [
        { label: 'Accent', value: '#1E66F5' },
        { label: 'Background', value: '#EFF1F5' },
        { label: 'Surface', value: '#E6E9EF' },
        { label: 'Text', value: '#4C4F69' },
        { label: 'Success', value: '#40A02B' },
        { label: 'Warn', value: '#DF8E1D' },
        { label: 'Danger', value: '#D20F39' },
      ],
      dark: [
        { label: 'Accent', value: '#89B4FA' },
        { label: 'Background', value: '#1E1E2E' },
        { label: 'Surface', value: '#313244' },
        { label: 'Text', value: '#CDD6F4' },
        { label: 'Success', value: '#A6E3A1' },
        { label: 'Warn', value: '#F9E2AF' },
        { label: 'Danger', value: '#F38BA8' },
      ],
    },
  },
] as const satisfies readonly PaletteDefinition[];

/** 配色 id 的联合类型，直接从注册表派生——加配色不用再手敲 union。 */
export type AppearancePalette = (typeof PALETTE_REGISTRY)[number]['id'];

/** 默认配色 = 注册表第一项（frost）。 */
export const DEFAULT_PALETTE: AppearancePalette = PALETTE_REGISTRY[0].id;

/** 面板展示顺序的 id 列表。 */
export const PALETTE_IDS: readonly AppearancePalette[] = PALETTE_REGISTRY.map(
  (p) => p.id,
);

/** id → 完整定义的查表，运行时常用。 */
export const PALETTE_BY_ID: Readonly<Record<AppearancePalette, PaletteDefinition>> =
  Object.fromEntries(PALETTE_REGISTRY.map((p) => [p.id, p])) as Readonly<
    Record<AppearancePalette, PaletteDefinition>
  >;

/** 把任意输入收敛为合法 palette id（非法值回退到默认）。 */
export function sanitizePalette(value: unknown): AppearancePalette {
  return typeof value === 'string' && value in PALETTE_BY_ID
    ? (value as AppearancePalette)
    : DEFAULT_PALETTE;
}
