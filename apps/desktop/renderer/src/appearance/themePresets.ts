/**
 * Peer Vellum 是 Peer Agent 桌面端的唯一设计语言。
 * 不再提供 8 个可调预设；Vellum 一以贯之。
 *
 * 此文件只保留：
 *   - DEFAULT_APPEARANCE_SETTINGS：第一次启动的默认值
 *   - PEER_VELLUM_TOKENS：浅/深两套快照，仅供测试断言/导出使用
 *
 * 真正的 token 值落在 styles/tokens.css，本文件只作语义副本。
 */

import type { AppearanceSettings, AppearanceScheme } from './appearanceTypes';

export const PEER_VELLUM_NAME = 'Peer Vellum';

export interface PeerVellumSnapshot {
  readonly scheme: AppearanceScheme;
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
}

/**
 * Vellum 视觉契约的核心三色锚点。
 * 这些值在 tokens.css 中已经固化，本对象只用于：
 *   1. 测试断言（验证锚点未漂移）
 *   2. 导出/分享（让外部工具识别这是 Vellum）
 */
export const PEER_VELLUM_TOKENS: Readonly<Record<AppearanceScheme, PeerVellumSnapshot>> = {
  light: {
    scheme: 'light',
    accent: '#9B3A2A',     // cinnabar-seal
    background: '#F1ECE0', // surface-vellum-base
    foreground: '#1A1612', // ink-base
  },
  dark: {
    scheme: 'dark',
    accent: '#D26450',
    background: '#1A1612',
    foreground: '#F1ECE0',
  },
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  mode: 'system',
  density: 'comfortable',
};
