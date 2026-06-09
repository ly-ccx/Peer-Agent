import type { CapabilityManifest } from '@peer-agent/protocol';
import type {
  CapabilityTone,
  CapabilityWorkbenchCounts,
  CapabilityWorkbenchItem,
  CapabilityWorkbenchSection,
  CapabilityWorkbenchTab,
} from './types';
import { healthToStatus } from './types';

function localizeCapability(fallback: string, localized: CapabilityManifest['localizedName'] | CapabilityManifest['localizedDescription'] | undefined) {
  return localized?.['zh-CN'] ?? fallback;
}

function sourceLabel(source: CapabilityManifest['source']) {
  if (source === 'mcp') return 'MCP';
  if (source === 'plugin') return 'Plugin';
  if (source === 'shell') return 'Shell';
  if (source === 'native') return 'Native';
  if (source === 'page_bridge') return 'Page bridge';
  return 'Private';
}

function riskTone(riskLevel: CapabilityManifest['riskLevel']): CapabilityTone {
  if (riskLevel === 'L0_inert' || riskLevel === 'L1_local_read') return 'good';
  if (riskLevel === 'L2_local_write' || riskLevel === 'L3_external_write') return 'warn';
  return 'danger';
}

function tabForCapability(capability: CapabilityManifest): CapabilityWorkbenchTab | null {
  if (capability.source === 'mcp') return 'mcp';
  return null;
}

function manifestToItem(capability: CapabilityManifest): CapabilityWorkbenchItem | null {
  const tab = tabForCapability(capability);
  if (!tab) return null;
  const status = healthToStatus(capability.health);
  const source = sourceLabel(capability.source);
  return {
    id: `manifest.${capability.capabilityId}`,
    tab,
    locality: 'local',
    name: localizeCapability(capability.name, capability.localizedName),
    description: localizeCapability(capability.description, capability.localizedDescription),
    kindLabel: source,
    originLabel: '本地',
    ...status,
    riskLevel: capability.riskLevel,
    riskLabel: capability.riskLevel.replace('_', ' '),
    riskTone: riskTone(capability.riskLevel),
    meta: [capability.capabilityId, capability.dataLevel],
    source: 'local_manifest',
    sourceDetail: `capabilities/${capability.capabilityId}`,
    steps: ['读取本地工具清单', '接入个人工具面', '等待云端策略裁剪'],
    permissions: [
      `risk: ${capability.riskLevel}`,
      `data: ${capability.dataLevel}`,
      `evidence: ${capability.evidencePolicy.returnMode}`,
    ],
    manifest: capability,
  };
}

export function buildCapabilityWorkbenchItems(capabilities: readonly CapabilityManifest[]) {
  return capabilities.flatMap((capability) => {
    const item = manifestToItem(capability);
    return item ? [item] : [];
  });
}

export function countCapabilityWorkbenchItems(items: readonly CapabilityWorkbenchItem[]): CapabilityWorkbenchCounts {
  return {
    skills: items.filter((item) => item.tab === 'skills').length,
    mcp: items.filter((item) => item.tab === 'mcp').length,
  };
}

export function groupCapabilityItems(
  items: readonly CapabilityWorkbenchItem[],
  activeTab: CapabilityWorkbenchTab,
): readonly CapabilityWorkbenchSection[] {
  const visible = items.filter((item) => item.tab === activeTab);
  const sections: readonly CapabilityWorkbenchSection[] = [
    {
      locality: 'cloud',
      title: `云端 (${visible.filter((item) => item.locality === 'cloud').length})`,
      items: visible.filter((item) => item.locality === 'cloud'),
    },
    {
      locality: 'local',
      title: `本地 (${visible.filter((item) => item.locality === 'local').length})`,
      items: visible.filter((item) => item.locality === 'local'),
    },
  ];
  return sections.filter((section) => section.items.length > 0);
}
