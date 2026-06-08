import type { CapabilityHealth, CapabilityManifest, CapabilityRiskLevel } from '@zeus-atlas/protocol';

export type CapabilityWorkbenchTab = 'skills' | 'mcp';

export type CapabilityLocality = 'cloud' | 'local';

export type CapabilityStatus = 'enabled' | 'disabled' | 'needs_auth' | 'catalog' | 'unavailable';

export type CapabilityTone = 'good' | 'warn' | 'danger' | 'muted';

export interface CapabilityWorkbenchItem {
  readonly id: string;
  readonly tab: CapabilityWorkbenchTab;
  readonly locality: CapabilityLocality;
  readonly name: string;
  readonly description: string;
  readonly kindLabel: string;
  readonly originLabel: string;
  readonly status: CapabilityStatus;
  readonly statusLabel: string;
  readonly statusTone: CapabilityTone;
  readonly riskLevel?: CapabilityRiskLevel;
  readonly riskLabel?: string;
  readonly riskTone?: CapabilityTone;
  readonly meta: readonly string[];
  readonly source: 'catalog' | 'local_manifest';
  readonly sourceDetail: string;
  readonly steps: readonly string[];
  readonly permissions: readonly string[];
  readonly endpoint?: string;
  readonly manifest?: CapabilityManifest;
}

export interface CapabilityWorkbenchCounts {
  readonly skills: number;
  readonly mcp: number;
}

export interface CapabilityWorkbenchSection {
  readonly locality: CapabilityLocality;
  readonly title: string;
  readonly items: readonly CapabilityWorkbenchItem[];
}

export function healthToStatus(health: CapabilityHealth): Pick<CapabilityWorkbenchItem, 'status' | 'statusLabel' | 'statusTone'> {
  if (health === 'available') {
    return { status: 'enabled', statusLabel: '已启用', statusTone: 'good' };
  }
  if (health === 'needs_permission') {
    return { status: 'needs_auth', statusLabel: '待授权', statusTone: 'warn' };
  }
  if (health === 'local_disabled' || health === 'policy_disabled') {
    return { status: 'disabled', statusLabel: '已停用', statusTone: 'muted' };
  }
  return { status: 'unavailable', statusLabel: '不可用', statusTone: 'danger' };
}
