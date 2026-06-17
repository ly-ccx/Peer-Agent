import { createToolRegistry } from './tool-registry.mjs';
import {
  buildAnthropicToolsFromRegistry,
  buildOpenAIToolsFromRegistry,
} from './provider-tool-materializer.mjs';

function nowIso() {
  return new Date().toISOString();
}

function executorCapabilityId(tool) {
  return tool.runtime?.executorCapabilityId || tool.capabilityId;
}

function sourceForCapability(capabilityId) {
  if (capabilityId === 'local.shell.exec') return 'shell';
  if (capabilityId?.startsWith('local.mcp.')) return 'mcp';
  if (capabilityId?.startsWith('local.skill.')) return 'plugin';
  return 'native';
}

function riskForTool(tool) {
  const policy = tool.permissionPolicy ?? {};
  if (policy.kind === 'shell') return 'L4_privileged';
  if (policy.kind === 'file-read') return 'L1_local_read';
  if (policy.kind === 'file-write') return 'L2_local_write';
  // interaction: 无副作用（只向用户提问并终止回合），归为最低风险。
  if (policy.kind === 'interaction') return 'L0_inert';
  // goal 计划读写：只写本地计划草稿/回写 Evidence，无外部副作用，归为最低风险。
  // goal-read：只读本地计划（恢复权威 taskId），无副作用，最低风险。
  if (policy.kind === 'goal-create' || policy.kind === 'goal-update' || policy.kind === 'goal-read') {
    return 'L0_inert';
  }
  return 'L2_local_write';
}

function dataLevelForTool(tool) {
  const policy = tool.permissionPolicy ?? {};
  if (policy.kind === 'file-read') return 'D1_internal';
  if (policy.kind === 'interaction') return 'D0_public';
  return 'D2_sensitive';
}

function evidencePolicyForTool(tool) {
  const policy = tool.permissionPolicy ?? {};
  if (policy.kind === 'shell') {
    return { returnMode: 'artifact_ref', maxChars: 4_000, redactSensitive: true };
  }
  if (policy.kind === 'file-write') {
    return { returnMode: 'diff', maxChars: 4_000, redactSensitive: false };
  }
  return { returnMode: 'summary', maxChars: 4_000, redactSensitive: false };
}

function manifestFromTool(tool) {
  if (tool.manifest && typeof tool.manifest === 'object') {
    return Object.freeze({
      health: 'available',
      ...tool.manifest,
    });
  }
  const capabilityId = executorCapabilityId(tool);
  return {
    capabilityId,
    name: tool.name,
    description: tool.prompt(),
    source: sourceForCapability(capabilityId),
    riskLevel: riskForTool(tool),
    dataLevel: dataLevelForTool(tool),
    health: 'available',
    inputSchema: tool.inputSchema,
    evidencePolicy: evidencePolicyForTool(tool),
  };
}

export function createRuntimeProjectionFromToolRegistry(registry, {
  projectionId = `projection:${Date.now()}`,
  sessionId = 'local-session',
  accessLevel = 'ask_before_local',
  createdAt = nowIso(),
} = {}) {
  return {
    projectionId,
    sessionId,
    accessLevel,
    capabilities: registry.listTools().map(manifestFromTool),
    createdAt,
  };
}

function isAvailable(capability) {
  return capability.health === 'available' || capability.health === 'needs_permission';
}

export function createProjectedToolRegistry(runtimeProjection, registry) {
  const projectedCapabilities = new Set(
    (runtimeProjection?.capabilities ?? [])
      .filter(isAvailable)
      .map((capability) => capability.capabilityId),
  );
  const tools = registry.listTools().filter((tool) => projectedCapabilities.has(executorCapabilityId(tool)));
  return createToolRegistry({ tools });
}

export function buildOpenAIToolsFromRuntimeProjection(runtimeProjection, registry) {
  return buildOpenAIToolsFromRegistry(createProjectedToolRegistry(runtimeProjection, registry));
}

export function buildAnthropicToolsFromRuntimeProjection(runtimeProjection, registry) {
  return buildAnthropicToolsFromRegistry(createProjectedToolRegistry(runtimeProjection, registry));
}
