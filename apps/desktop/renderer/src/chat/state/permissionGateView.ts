import type { ClientToolCall } from '@peer-agent/protocol';

export type PermissionGateVariant =
  | 'default'
  | 'goal-scope'
  | 'goal-irreversible'
  | 'goal-high-risk'
  | 'hook-approval';

export interface PermissionGateView {
  readonly variant: PermissionGateVariant;
  readonly isGoalConfirmation: boolean;
  readonly badge?: string;
  readonly capabilityLabel: string;
  readonly preview: string;
  readonly allowLabel?: string;
  readonly denyLabel?: string;
}

const PREVIEW_MAX = 80;

function isZhLocale(locale: string | undefined): boolean {
  return locale !== 'en-US';
}

function truncatePreview(value: string): string {
  return value.length > PREVIEW_MAX ? `${value.slice(0, PREVIEW_MAX)}...` : value;
}

function pickFirstString(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function extractCommandPreview(call: ClientToolCall): string {
  const args = call.argumentsPreview;
  const fullArgs = call.arguments;
  const command =
    typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string'
        ? args.cmd
        : typeof args.script === 'string'
          ? args.script
          : typeof fullArgs?.command === 'string'
            ? fullArgs.command
            : typeof fullArgs?.cmd === 'string'
              ? fullArgs.cmd
              : typeof fullArgs?.script === 'string'
                ? fullArgs.script
                : pickFirstString(args) ?? pickFirstString(fullArgs);
  if (!command) return '';
  return truncatePreview(command);
}

function extractPathPreview(call: ClientToolCall): string {
  const detail = call.confirmation?.detail;
  if (typeof detail === 'string' && detail.trim()) return truncatePreview(detail.trim());
  const args = call.arguments;
  if (typeof args?.path === 'string' && args.path.trim()) return truncatePreview(args.path.trim());
  return extractCommandPreview(call);
}

function isHookApproval(call: ClientToolCall): boolean {
  return call.confirmation?.kind === 'hook-approval';
}

function isScopeConfirmation(call: ClientToolCall): boolean {
  return call.capabilityId === 'goal.scope.expand' || call.confirmation?.kind === 'scope_expansion';
}

function isHighRiskConfirmation(call: ClientToolCall): boolean {
  return call.capabilityId === 'goal.high_risk.action' || call.confirmation?.kind === 'high_risk';
}

function isIrreversibleConfirmation(call: ClientToolCall): boolean {
  if (call.capabilityId === 'goal.irreversible.action') return true;
  const kind = call.confirmation?.kind;
  return Boolean(kind && kind !== 'scope_expansion' && kind !== 'high_risk');
}

export function buildPermissionGateView(call: ClientToolCall, locale?: string): PermissionGateView {
  const zh = isZhLocale(locale);
  if (isHookApproval(call)) {
    return {
      variant: 'hook-approval',
      isGoalConfirmation: false,
      badge: zh ? 'Hook 确认' : 'Hook check',
      capabilityLabel: zh ? '生命周期 Hook 请求确认' : 'Lifecycle hook approval',
      preview: extractCommandPreview(call) || extractPathPreview(call) || call.reason,
      allowLabel: zh ? '确认执行' : 'Allow action',
      denyLabel: zh ? '拒绝执行' : 'Deny action',
    };
  }
  if (isScopeConfirmation(call)) {
    return {
      variant: 'goal-scope',
      isGoalConfirmation: true,
      badge: zh ? 'Goal 确认' : 'Goal check',
      capabilityLabel: zh ? '范围扩展' : 'Scope expansion',
      preview: extractPathPreview(call),
      allowLabel: zh ? '确认扩展' : 'Allow expansion',
      denyLabel: zh ? '拒绝扩展' : 'Deny expansion',
    };
  }
  if (isHighRiskConfirmation(call)) {
    return {
      variant: 'goal-high-risk',
      isGoalConfirmation: true,
      badge: zh ? 'Goal 确认' : 'Goal check',
      capabilityLabel: zh ? '高风险动作' : 'High-risk action',
      preview: extractCommandPreview(call) || extractPathPreview(call),
      allowLabel: zh ? '确认执行' : 'Allow action',
      denyLabel: zh ? '拒绝执行' : 'Deny action',
    };
  }
  if (isIrreversibleConfirmation(call)) {
    return {
      variant: 'goal-irreversible',
      isGoalConfirmation: true,
      badge: zh ? 'Goal 确认' : 'Goal check',
      capabilityLabel: zh ? '不可逆动作' : 'Irreversible action',
      preview: extractCommandPreview(call) || extractPathPreview(call),
      allowLabel: zh ? '确认执行' : 'Allow action',
      denyLabel: zh ? '拒绝执行' : 'Deny action',
    };
  }
  return {
    variant: 'default',
    isGoalConfirmation: false,
    capabilityLabel: call.capabilityId,
    preview: extractCommandPreview(call),
  };
}
