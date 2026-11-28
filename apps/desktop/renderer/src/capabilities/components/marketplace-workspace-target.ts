import type { SkillInstallTarget } from '@peer-agent/protocol';

export function defaultWorkspaceSelection(targets: readonly SkillInstallTarget[]): readonly string[] {
  const available = targets.filter((target) => target.available);
  const target = available.find((target) => target.isActive) ?? available[0];
  return target ? [target.workspaceId] : [];
}

export function workspaceSelectionLabel(names: readonly string[]): string {
  if (names.length > 1) return `已选 ${names.length} 个机器人`;
  return names[0] ?? '请选择机器人';
}

export function marketplaceInstallLabel(verb: string, scope: 'global' | 'workspace', count: number): string {
  if (scope === 'global') return `${verb}到全局`;
  return count > 1 ? `${verb}到 ${count} 个机器人` : `${verb}到机器人`;
}

export function skillWorkspacePathKey(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  // Rust canonicalizes Windows paths to the verbatim namespace. The IPC directory uses ordinary paths.
  const normalized = value.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  return /^[A-Za-z]:\/|^\/\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

const TARGET_ERRORS: Readonly<Record<string, string>> = {
  workspace_install_target_required: '请选择机器人',
  workspace_install_target_missing: '工作目录不存在',
  workspace_install_target_not_directory: '绑定路径不是目录',
  workspace_install_target_unreadable: '无法读取工作目录',
  workspace_install_target_not_registered: '机器人已停用、归档或解绑',
  workspace_install_target_mismatch: '机器人绑定已变更，请重新选择',
  workspace_install_target_changed: '机器人绑定已变更，请重新选择',
  skill_install_path_conflict: '技能路径已被链接或其他文件占用',
  EACCES: '没有目录写入权限',
  EPERM: '没有目录写入权限',
  EROFS: '目录所在的文件系统为只读',
  ENOENT: '工作目录已不可用',
  ENOSPC: '磁盘空间不足',
};

export function describeWorkspaceInstallError(error?: string, code?: string): string | undefined {
  return (code && TARGET_ERRORS[code]) || (error && TARGET_ERRORS[error]) || undefined;
}
