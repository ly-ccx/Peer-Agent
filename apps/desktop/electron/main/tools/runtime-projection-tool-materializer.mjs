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
  if (capabilityId?.startsWith('local.web.')) return 'web';
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
  // goal-explore：仅登记一个只读 Explorer 子 Agent 请求（不直接执行探查、无副作用），
  // 归为最低风险，使其在 goal 模式计划批准前后均可放行。实际探查由 Runner 派发的
  // 只读 Explorer 在其自身权限边界内执行。
  if (policy.kind === 'goal-explore') {
    return 'L0_inert';
  }
  // web-fetch: 联网读取外部网页，按 ADR 38 归为 L3_external_write（需联网授权）。
  if (policy.kind === 'web-fetch') return 'L3_external_write';
  // browser-control: 操控可见内嵌浏览器（导航/点击/输入/截图/读DOM），按 ADR 40 归为
  // L3_external_write（导航联网 + 页面副作用，需授权）。
  if (policy.kind === 'browser-control') return 'L3_external_write';
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
  // web-fetch: 网页正文落本地 artifact，仅回灌摘要+ref（ADR 38）。
  if (policy.kind === 'web-fetch') {
    return { returnMode: 'artifact_ref', maxChars: 4_000, redactSensitive: true };
  }
  // browser-control: 截图(PNG)/DOM 文本落本地 artifact，仅回灌摘要+ref（ADR 40）。
  if (policy.kind === 'browser-control') {
    return { returnMode: 'artifact_ref', maxChars: 4_000, redactSensitive: true };
  }
  if (policy.kind === 'file-write') {
    return { returnMode: 'diff', maxChars: 4_000, redactSensitive: false };
  }
  return { returnMode: 'summary', maxChars: 4_000, redactSensitive: false };
}

// 工具是否在当前会话模式下可投影（ADR 35）。
// wire 值迁移后（见 ADR 41 / goal-mode-ultrathink-workflow 设计文档）:'goal' 是独立的自驱
// 目标模式,投影层不再把它归一为 'plan',而是按 goal 独立过滤工具可用性。规划/回写工具
// (goal_* 系列)在 goal-tool-definitions 中声明 availableInModes:['plan','goal'],故两模式均可用。
// 未声明 availableInModes 的工具在 chat/plan/goal 维持向后兼容；
// explorer 是更受限的只读子 Agent profile，必须显式声明可用，避免默认暴露写入/MCP/Web 能力。
// 传入 mode 为 null/undefined（无模式上下文）时不做模式过滤。
// wire 值迁移后 'goal' 独立成模式,不再按 'plan' 归一;存量历史 'goal'（旧 plan 语义）已由
// conversation-store 的一次性数据迁移改写为 'plan',不会到达此处。
function normalizeProjectionMode(mode) {
  return mode;
}

function isToolAvailableInMode(tool, mode) {
  const normalizedMode = normalizeProjectionMode(mode);
  const modes = tool.availableInModes;
  if (normalizedMode == null) return true;
  if (normalizedMode === 'explorer' && (!Array.isArray(modes) || modes.length === 0)) return false;
  if (!Array.isArray(modes) || modes.length === 0) return true;
  return modes.includes(normalizedMode);
}

function manifestFromTool(tool, mode) {
  const modeExcluded = !isToolAvailableInMode(tool, mode);
  if (tool.manifest && typeof tool.manifest === 'object') {
    return Object.freeze({
      health: modeExcluded ? 'mode_excluded' : 'available',
      ...tool.manifest,
      // mode 是运行时事实，覆盖预置 manifest 的 health，确保模式隔离生效。
      ...(modeExcluded ? { health: 'mode_excluded' } : {}),
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
    health: modeExcluded ? 'mode_excluded' : 'available',
    inputSchema: tool.inputSchema,
    evidencePolicy: evidencePolicyForTool(tool),
  };
}

export function createRuntimeProjectionFromToolRegistry(registry, {
  projectionId = `projection:${Date.now()}`,
  sessionId = 'local-session',
  accessLevel = 'ask_before_local',
  createdAt = nowIso(),
  mode = null,
} = {}) {
  return {
    projectionId,
    sessionId,
    accessLevel,
    capabilities: registry.listTools().map((tool) => manifestFromTool(tool, mode)),
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
