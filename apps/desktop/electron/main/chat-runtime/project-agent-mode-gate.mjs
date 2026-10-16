import { createFailedClientToolResult, createPermissionGrant, evaluateProjectAgentTurn } from '@peer-agent/runtime-node';

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
    execution: { call, grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }), result },
  };
}

/** 副作用闸拒绝时补上同一条 Evidence 路径，不另开记录通道。 */
export function attachProjectAgentDenialEvidence(denial, { call, locale = 'zh-CN', reason }) {
  if (denial?.execution?.result?.evidence) return denial;
  return {
    ...denial,
    execution: {
      call,
      grant: createPermissionGrant({ toolCallId: call.toolCallId, granted: false, scope: call.capabilityId }),
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
