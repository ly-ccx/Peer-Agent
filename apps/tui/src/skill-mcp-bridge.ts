/**
 * CLI Skill/MCP bridge: reuse the shared Node registries/providers while keeping
 * projection and execution behind the TUI host boundary.
 */
import path from 'node:path';

import type { RuntimeToolDefinition } from '@peer-agent/runtime-core';
import {
  createLocalMcpProvider,
  createLocalSkillProvider,
  createMcpRegistry,
  createMcpToolDefinitionsFromRegistry,
  createSkillStore,
} from '@peer-agent/runtime-node';
import type { RuntimeSdkProviderExecution, RuntimeSdkToolCall } from '@peer-agent/runtime-sdk';

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
  };
}
