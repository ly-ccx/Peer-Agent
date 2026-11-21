import { NODE_SHELL_RISK_ORDER, type NodeRuntimePermissionPrompt } from '@peer-agent/runtime-node';
import type { LocalAccessLevel } from '@peer-agent/protocol';

function isNodeShellRiskLevel(value: unknown): value is keyof typeof NODE_SHELL_RISK_ORDER {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(NODE_SHELL_RISK_ORDER, value);
}

export function automaticAccessDecision(
  accessLevel: LocalAccessLevel,
  prompt: NodeRuntimePermissionPrompt,
  botPolicy = false,
): { readonly granted: true; readonly reason: string } | null {
  if (accessLevel === 'full_local') {
    return { granted: true, reason: 'local_access_level_full' };
  }
  if (accessLevel !== 'session_local' || prompt.confirmation.kind !== 'capability-approval') {
    return null;
  }
  if (prompt.confirmation.approvalKind === 'file-write' && !botPolicy) {
    return { granted: true, reason: 'local_access_level_session' };
  }
  if (
    prompt.confirmation.approvalKind === 'shell-exec'
    && isNodeShellRiskLevel(prompt.riskLevel)
    && NODE_SHELL_RISK_ORDER[prompt.riskLevel] <= NODE_SHELL_RISK_ORDER.L3_external_write
  ) {
    return { granted: true, reason: 'local_access_level_session' };
  }
  return null;
}

