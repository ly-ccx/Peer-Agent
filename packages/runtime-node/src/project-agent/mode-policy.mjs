/**
 * project_agent 回合能看见、能执行的能力。
 * 这是白名单的唯一定义。后续卡片只往这个数组追加 capabilityId。
 * 桌面执行闸与以后的 TUI 都调用这里，不各自维护一份。
 */
export const PROJECT_AGENT_ALLOWED_CAPABILITIES = Object.freeze([
  'local.file.list',
  'local.file.read',
  'local.file.search',
  'local.search.aggregate',
]);

const ALLOWED = new Set(PROJECT_AGENT_ALLOWED_CAPABILITIES);

/** permission-gate 在该模式下应拒绝的 kind。本卡不改 permission-gate，执行闸在授权前用这份名单兜底。 */
const DENIED_PERMISSION_KINDS = new Set(['file-write', 'shell']);

export function isProjectAgentTurn({ mode, role } = {}) {
  return mode === 'project_agent' || role === 'project_agent';
}

export function isProjectAgentCapabilityAllowed(capabilityId) {
  return typeof capabilityId === 'string' && ALLOWED.has(capabilityId);
}

export function isProjectAgentDeniedPermissionKind(kind) {
  if (typeof kind !== 'string' || !kind) return false;
  if (DENIED_PERMISSION_KINDS.has(kind)) return true;
  return kind === 'browser' || kind.startsWith('browser-') || kind.startsWith('browser_');
}

/**
 * 回合不是 project_agent 时不介入（applies: false）。
 * 是该回合时：capabilityId 不在白名单，或 kind 属于文件写 / Shell / 浏览器，一律拒绝。
 * 放行时 accessLevel 固定为 restricted_local。
 */
export function evaluateProjectAgentTurn({
  mode,
  role,
  capabilityId,
  permissionKind,
} = {}) {
  if (!isProjectAgentTurn({ mode, role })) {
    return { applies: false, allowed: true };
  }
  const accessLevel = 'restricted_local';
  if (!isProjectAgentCapabilityAllowed(capabilityId)) {
    return {
      applies: true,
      allowed: false,
      reason: 'project_agent_capability_denied',
      detail: 'capability',
      accessLevel,
    };
  }
  if (isProjectAgentDeniedPermissionKind(permissionKind)) {
    return {
      applies: true,
      allowed: false,
      reason: 'project_agent_capability_denied',
      detail: 'permission_kind',
      accessLevel,
    };
  }
  return { applies: true, allowed: true, accessLevel };
}
