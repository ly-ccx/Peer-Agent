import {
  resolveBotMcpEnabled,
  resolveBotSkillEnabled,
  type BotCapabilityPolicy,
  type CapabilityManifest,
  type LocalMcpServerView,
  type SkillSummary,
} from '@peer-agent/protocol';

export interface BotMountedSkillItem {
  readonly skillId: string;
  readonly name: string;
  readonly description: string;
  readonly scope: 'global' | 'workspace';
  readonly defaultEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly overridden: boolean;
  readonly version?: string;
}

export interface BotMountedMcpTool {
  readonly name: string;
  readonly description: string;
  readonly visible: boolean;
}

export interface BotMountedMcpItem {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly transport: string;
  readonly toolsCount: number;
  readonly visibleToolsCount: number;
  readonly tools: readonly BotMountedMcpTool[];
  readonly healthStatus: string;
  readonly trusted: boolean;
  readonly defaultEnabled: boolean;
  readonly effectiveEnabled: boolean;
  readonly overridden: boolean;
}

export interface BotBuiltinCapabilityItem {
  readonly key: 'files' | 'shell' | 'web';
  readonly count: number;
}

/** Deduplicate skills matching Rust `SkillCatalog::discover`: workspace scope shadows global scope. */
export function mergeBotSkills(
  rawSkills: readonly SkillSummary[],
  policy: BotCapabilityPolicy | null | undefined,
): BotMountedSkillItem[] {
  const byId = new Map<string, SkillSummary>();
  for (const skill of rawSkills) {
    if (!skill?.skillId) continue;
    const existing = byId.get(skill.skillId);
    if (!existing || (existing.scope !== 'workspace' && skill.scope === 'workspace')) {
      byId.set(skill.skillId, skill);
    }
  }
  return [...byId.values()]
    .map((skill) => {
      const defaultEnabled = skill.enabled !== false;
      const effectiveEnabled = resolveBotSkillEnabled(policy, skill.skillId, defaultEnabled);
      return {
        skillId: skill.skillId,
        name: skill.name || skill.skillId,
        description: skill.description || '',
        scope: skill.scope === 'workspace' ? 'workspace' as const : 'global' as const,
        defaultEnabled,
        effectiveEnabled,
        overridden: effectiveEnabled !== defaultEnabled,
        version: skill.version,
      };
    })
    .sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'workspace' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function mergeBotMcps(
  rawServers: readonly LocalMcpServerView[],
  policy: BotCapabilityPolicy | null | undefined,
): BotMountedMcpItem[] {
  return rawServers
    .filter((server): server is LocalMcpServerView => Boolean(server && (server.id || server.mcpId)))
    .map((server) => {
      const id = server.id || server.mcpId || '';
      const defaultEnabled = server.enabled !== false;
      const effectiveEnabled = resolveBotMcpEnabled(policy, id, defaultEnabled);
      const tools: BotMountedMcpTool[] = Array.isArray(server.tools)
        ? server.tools
          .map((tool) => ({
            name: tool.name || '',
            description: tool.description || '',
            visible: tool.visible !== false,
          }))
          .filter((tool) => Boolean(tool.name))
        : [];
      const visibleToolsCount = typeof server.visibleToolsCount === 'number'
        ? server.visibleToolsCount
        : tools.filter((tool) => tool.visible).length;
      return {
        id,
        name: server.displayName || server.name || id,
        description: server.description || '',
        transport: server.transport || 'streamable_http',
        toolsCount: typeof server.toolsCount === 'number' ? server.toolsCount : tools.length,
        visibleToolsCount,
        tools,
        healthStatus: server.health?.status || 'unknown',
        trusted: server.policy?.trusted !== false,
        defaultEnabled,
        effectiveEnabled,
        overridden: effectiveEnabled !== defaultEnabled,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function summarizeBuiltinCapabilities(
  manifests: readonly CapabilityManifest[],
): BotBuiltinCapabilityItem[] {
  let files = 0;
  let shell = 0;
  let web = 0;
  for (const manifest of manifests) {
    if (manifest.source === 'mcp' || manifest.source === 'plugin') continue;
    const id = manifest.capabilityId || '';
    if (id.startsWith('local.file.') || id.startsWith('local.git.') || id.startsWith('local.search.')) {
      files += 1;
    } else if (id.startsWith('local.shell.') || manifest.source === 'shell') {
      shell += 1;
    } else if (id.startsWith('local.web.') || manifest.source === 'web') {
      web += 1;
    }
  }
  return [
    { key: 'files', count: Math.max(files, 1) },
    { key: 'shell', count: Math.max(shell, 1) },
    { key: 'web', count: Math.max(web, 1) },
  ];
}
