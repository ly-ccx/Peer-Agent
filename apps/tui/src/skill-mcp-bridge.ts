/**
 * CLI Skill/MCP bridge: reuse the Desktop registries/providers while keeping
 * projection and execution behind the TUI host boundary.
 */
import path from 'node:path';

import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import type { RuntimeSdkProviderExecution, RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';
// Static imports let `bun --compile` embed the shared plain-ESM implementations.
// @ts-expect-error Shared Desktop ESM module has no declaration file.
import { createMcpRegistry } from '../../desktop/electron/main/mcp-registry.mjs';
// @ts-expect-error Shared Desktop ESM module has no declaration file.
import { createSkillStore } from '../../desktop/electron/main/skill-store.mjs';
// @ts-expect-error Shared Desktop ESM module has no declaration file.
import { createLocalMcpProvider } from '../../desktop/electron/main/runtime-gateway/local-mcp-provider.mjs';
// @ts-expect-error Shared Desktop ESM module has no declaration file.
import { createLocalSkillProvider } from '../../desktop/electron/main/runtime-gateway/local-skill-provider.mjs';
// @ts-expect-error Shared Desktop ESM module has no declaration file.
import { createMcpToolDefinitionsFromRegistry } from '../../desktop/electron/main/tools/mcp-tool-definitions.mjs';

const MCP_PREFIX = 'local.mcp.';
const SKILL_PREFIX = 'local.skill.';
const USER_MODE_SCOPES = Object.freeze(['chat', 'plan', 'goal'] as const);

type PermissionDecision = Readonly<{ granted: boolean; reason: string }>;
type PermissionRequestHandler = (prompt: never) => Promise<PermissionDecision>;

type BridgeExecutionContext = Readonly<{
  locale?: string;
  requestPermission?: PermissionRequestHandler;
}>;

type SharedProvider = Readonly<{
  capabilityPrefix: string;
  executeCapability(
    request: Readonly<{ call: RuntimeSdkToolCall & Readonly<Record<string, unknown>> }>,
    context?: BridgeExecutionContext,
  ): Promise<RuntimeSdkProviderExecution | null>;
}>;

export type TuiSkillSummary = Readonly<{
  skillId: string;
  name?: string;
  description?: string;
  whenToUse?: string;
  enabled?: boolean;
}>;

export type TuiMcpServerSummary = Readonly<{
  id: string;
  displayName: string;
  enabled: boolean;
  toolsCount: number;
  visibleToolsCount: number;
  health: Readonly<{ status?: string; message?: string }>;
  tools: readonly Readonly<{ name?: string; toolName?: string; description?: string; visible?: boolean }>[];
}>;

type SkillStore = Readonly<{
  listSkills(): readonly TuiSkillSummary[];
  readSkillContext(skillId: string): unknown;
  refresh(): readonly TuiSkillSummary[];
  enableSkill(skillId: string): readonly TuiSkillSummary[];
  disableSkill(skillId: string): readonly TuiSkillSummary[];
}>;

type McpRegistry = Readonly<{
  listCapabilityManifests(): readonly Readonly<Record<string, unknown>>[];
  listInstalled(): readonly TuiMcpServerSummary[];
  setEnabled(serverId: string, enabled: boolean): unknown;
  path?: string;
}>;

export interface SkillMcpBridgeOptions {
  readonly userDataPath: string;
  readonly workspacePath?: string | null;
  readonly skillStore?: SkillStore;
  readonly mcpRegistry?: McpRegistry;
  readonly skillProvider?: SharedProvider;
  readonly mcpProvider?: SharedProvider;
}

export interface SkillMcpExecuteInput {
  readonly capabilityId: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId: string;
  readonly mode?: string;
  readonly locale?: string;
  readonly requestPermission?: BridgeExecutionContext['requestPermission'];
}

function normalizeInputSchema(value: unknown): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { type: 'object', additionalProperties: true };
}

function skillToolDefinition(skill: TuiSkillSummary): RuntimeToolDefinition {
  const description = [skill.description, skill.whenToUse].filter(Boolean).join('\n');
  return {
    name: `skill__${skill.skillId}`,
    capabilityId: `${SKILL_PREFIX}${skill.skillId}`,
    modeScopes: USER_MODE_SCOPES,
    description: description || `Load the local skill ${skill.name || skill.skillId} instructions.`,
    inputSchema: {
      type: 'object',
      properties: {
        userMessage: {
          type: 'string',
          description: 'The user request that triggered this skill.',
        },
      },
      additionalProperties: true,
    },
    metadata: {
      source: 'skill',
      skillId: skill.skillId,
      skillName: skill.name || skill.skillId,
    },
  };
}

function mcpToolDefinitions(registry: McpRegistry): readonly RuntimeToolDefinition[] {
  return createMcpToolDefinitionsFromRegistry(registry).map((tool: Readonly<Record<string, unknown>>) => ({
    name: String(tool.name || tool.capabilityId || 'mcp_tool'),
    capabilityId: String(tool.capabilityId || ''),
    modeScopes: USER_MODE_SCOPES,
    description: typeof tool.description === 'string'
      ? tool.description
      : typeof tool.prompt === 'function'
        ? String(tool.prompt())
        : undefined,
    inputSchema: normalizeInputSchema(tool.inputSchema),
    metadata: {
      source: 'mcp',
    },
  }));
}

function callFor(input: SkillMcpExecuteInput): RuntimeSdkToolCall & Readonly<Record<string, unknown>> {
  return {
    toolCallId: input.toolCallId,
    capabilityId: input.capabilityId,
    name: input.capabilityId,
    input: input.args,
    inputPreview: input.args,
    mode: input.mode,
    arguments: input.args,
    argumentsPreview: input.args,
  };
}

export function createTuiSkillMcpBridge(options: SkillMcpBridgeOptions) {
  const skillStore: SkillStore = options.skillStore
    ?? createSkillStore({ userDataPath: options.userDataPath, workspacePath: options.workspacePath ?? null }) as SkillStore;
  const mcpRegistry: McpRegistry = options.mcpRegistry ?? createMcpRegistry({
    registryPath: path.join(options.userDataPath, 'mcp-registry.json'),
  }) as McpRegistry;
  const skillProvider: SharedProvider = options.skillProvider
    ?? createLocalSkillProvider({ skillStore }) as SharedProvider;
  const mcpProvider: SharedProvider = options.mcpProvider
    ?? createLocalMcpProvider({ mcpRegistry }) as SharedProvider;

  const listSkillTools = (): readonly RuntimeToolDefinition[] => skillStore
    .listSkills()
    .filter((skill) => skill.enabled !== false)
    .map(skillToolDefinition);

  const listMcpTools = (): readonly RuntimeToolDefinition[] => mcpToolDefinitions(mcpRegistry);
  const listSkills = (): readonly TuiSkillSummary[] => skillStore.listSkills();
  const refreshSkills = (): readonly TuiSkillSummary[] => skillStore.refresh();
  const setSkillEnabled = (skillId: string, enabled: boolean): readonly TuiSkillSummary[] => enabled
    ? skillStore.enableSkill(skillId)
    : skillStore.disableSkill(skillId);
  const listMcpServers = (): readonly TuiMcpServerSummary[] => mcpRegistry.listInstalled();
  const refreshMcp = (): readonly TuiMcpServerSummary[] => mcpRegistry.listInstalled();
  const setMcpServerEnabled = (serverId: string, enabled: boolean): readonly TuiMcpServerSummary[] => {
    mcpRegistry.setEnabled(serverId, enabled);
    return mcpRegistry.listInstalled();
  };

  const toolDefinitions = (): readonly RuntimeToolDefinition[] => [
    ...listSkillTools(),
    ...listMcpTools(),
  ];

  const isSkillCapability = (capabilityId: string) => capabilityId.startsWith(SKILL_PREFIX);
  const isMcpCapability = (capabilityId: string) => capabilityId.startsWith(MCP_PREFIX);
  const isCapability = (capabilityId: string) => (
    isSkillCapability(capabilityId) || isMcpCapability(capabilityId)
  );

  const execute = async (input: SkillMcpExecuteInput): Promise<RuntimeSdkProviderExecution> => {
    const provider = isSkillCapability(input.capabilityId)
      ? skillProvider
      : isMcpCapability(input.capabilityId)
        ? mcpProvider
        : null;
    if (!provider) throw new Error(`Unsupported Skill/MCP capability: ${input.capabilityId}`);

    const execution = await provider.executeCapability(
      { call: callFor(input) },
      {
        locale: input.locale ?? 'zh-CN',
        requestPermission: input.requestPermission,
      },
    );
    if (!execution) throw new Error(`Skill/MCP provider declined capability: ${input.capabilityId}`);
    return execution;
  };

  const discoveryHint = (): string => {
    const skills = skillStore.listSkills().filter((skill) => skill.enabled !== false);
    const mcpTools = listMcpTools();
    const lines = [
      '## Local Skill and MCP discovery',
      `Skill root: ${path.join(options.userDataPath, 'skills')}`,
      `MCP registry: ${path.join(options.userDataPath, 'mcp-registry.json')}`,
    ];
    if (skills.length > 0) {
      lines.push('Available local skills:');
      for (const skill of skills) {
        const hint = skill.whenToUse || skill.description || '';
        lines.push(`- ${skill.skillId}${hint ? `: ${hint}` : ''}`);
      }
    }
    if (mcpTools.length > 0) {
      lines.push(`Available MCP tools: ${mcpTools.map((tool) => tool.name).join(', ')}`);
    }
    lines.push('Use the projected Skill/MCP tools directly when they match the user request.');
    return lines.join('\n');
  };

  return {
    skillStore,
    mcpRegistry,
    toolDefinitions,
    listSkillTools,
    listMcpTools,
    listSkills,
    refreshSkills,
    setSkillEnabled,
    listMcpServers,
    refreshMcp,
    setMcpServerEnabled,
    isCapability,
    isSkillCapability,
    isMcpCapability,
    execute,
    discoveryHint,
  };
}
