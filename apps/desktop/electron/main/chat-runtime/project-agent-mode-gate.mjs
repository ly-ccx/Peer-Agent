import { createFailedClientToolResult, evaluateProjectAgentTurn } from '@peer-agent/runtime-node';

/**
 * 桌面执行闸。判定只来自 mode-policy。
 * 文件写、Shell、浏览器 kind 的兜底拒绝也在这里，发生在 PermissionGrant 之前。
 * permission-gate.mjs 留给 B2-02；本卡不改共享访问级别。
 */
export function evaluateProjectAgentModeGate(input = {}) {
  return evaluateProjectAgentTurn(input);
}

export function buildProjectAgentModeDenial({
  call,
  locale = 'zh-CN',
  toolName,
  capabilityId,
  detail = null,
}) {
  const reason = 'project_agent_capability_denied';
  const zh = locale !== 'en-US';
  const message = zh
    ? `项目代理只能使用已允许的只读能力，已拒绝 ${toolName || capabilityId || '该工具'}。`
    : `Project agent can only run allowed read capabilities. Denied ${toolName || capabilityId || 'this tool'}.`;
  const result = createFailedClientToolResult({
    call,
    locale,
    reason,
    status: 'denied',
    dataLevel: 'D1_internal',
  });
  return {
    success: false,
    error: message,
    output: JSON.stringify({
      kind: 'project_agent_mode_gate_denied',
      tool: toolName ?? null,
      capabilityId: capabilityId ?? call?.capabilityId ?? null,
      reason,
      detail: detail ?? undefined,
      message,
    }),
    projectAgentDenied: true,
    execution: { call, result },
  };
}

/**
 * 共享 permission-gate 的 accessLevel 不能按回合切换。
 * 项目代理回合若收到 full/session 的自动授权，改成拒绝，避免用户的全局级别漏进这个回合。
 */
export function restrictProjectAgentPermission(requestPermission) {
  if (typeof requestPermission !== 'function') return requestPermission;
  return async (request) => {
    const decision = await requestPermission(request);
    if (
      decision?.reason === 'local_access_level_full'
      || decision?.reason === 'local_access_level_session'
    ) {
      return {
        granted: false,
        reason: 'project_agent_capability_denied',
        grant: decision.grant
          ? { ...decision.grant, granted: false, duration: 'denied' }
          : undefined,
      };
    }
    return decision;
  };
}

/** 副作用闸拒绝时补上同一条 Evidence 路径，不另开记录通道。 */
export function attachProjectAgentDenialEvidence(denial, { call, locale = 'zh-CN', reason }) {
  if (denial?.execution?.result?.evidence) return denial;
  return {
    ...denial,
    execution: {
      call,
      result: createFailedClientToolResult({
        call,
        locale,
        reason,
        status: 'denied',
        dataLevel: 'D1_internal',
      }),
    },
  };
}
