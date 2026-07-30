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

import {
  DEFAULT_GIT_BRANCH_PREFIX,
  resolveGitBranchPrefix,
} from '@peer-agent/system-context/host-config-instructions';

export {
  DEFAULT_GIT_BRANCH_PREFIX,
  resolveGitBranchPrefix,
};

/** 从 settings 记录读取并解析分支前缀（缺省回退默认）。 */
export function readGitBranchPrefixFromSettings(
  settings: Record<string, unknown> | null | undefined,
): string {
  return resolveGitBranchPrefix(settings?.gitBranchPrefix);
}
