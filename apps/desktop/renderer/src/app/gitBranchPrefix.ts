/**
 * Git 分支前缀：共享默认值与解析。
 *
 * 设置页展示、App 读取、消息注入必须走同一解析，避免：
 * - UI 显示 PeerAgent/（空值回退）
 * - 注入侧拿到空串并跳过约束
 * 这种「看起来开了，其实没生效」的分裂。
 *
 * 产品语义：空 / 缺省 / 空白 一律回退到默认前缀；
 * 设置页失焦保存时也会把空值写成默认，因此不存在「显式关闭前缀」状态。
 */

export const DEFAULT_GIT_BRANCH_PREFIX = 'PeerAgent/';

/**
 * 解析生效中的分支前缀。
 * - 非字符串 / null / undefined → 默认
 * - 仅空白 → 默认
 * - 其他 → trim 后的值
 */
export function resolveGitBranchPrefix(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_GIT_BRANCH_PREFIX;
  const trimmed = value.trim();
  return trimmed || DEFAULT_GIT_BRANCH_PREFIX;
}

/** 从 settings 记录读取并解析分支前缀（缺省回退默认）。 */
export function readGitBranchPrefixFromSettings(
  settings: Record<string, unknown> | null | undefined,
): string {
  return resolveGitBranchPrefix(settings?.gitBranchPrefix);
}
