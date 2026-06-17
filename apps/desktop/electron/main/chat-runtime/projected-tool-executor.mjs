import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { getDataHome } from '../data-store.mjs';
import {
  buildGoalModeDenial,
  evaluateGoalModeGate,
  resolveGoalPlanGate,
} from './goal-mode-gate.mjs';
import { createLocalToolHost } from '../runtime-gateway/local-tool-host.mjs';
import { createLocalShellProvider } from '../runtime-gateway/local-shell-provider.mjs';
import { createShellArtifactStore } from '../runtime-gateway/shell-artifacts.mjs';
import { nowIso } from '../runtime-gateway/tool-result-factory.mjs';
import {
  DEFAULT_RUNTIME_PROJECTION,
  DEFAULT_TOOL_REGISTRY,
} from '../tools/index.mjs';

const shellArtifactStore = createShellArtifactStore({ userDataPath: getDataHome() });

function formatContextResult(payload) {
  return JSON.stringify(payload, null, 2);
}

function createSessionStore(locale) {
  return {
    getSession() {
      return { locale };
    },
  };
}

function executorCapabilityId(tool) {
  return tool?.runtime?.executorCapabilityId || tool?.capabilityId || null;
}

// 工具执行 cwd 的安全兜底:绝不回退到 process.cwd()(打包后 = 根目录),
// 而是回退到用户主目录下的默认工作区 ~/PeerAgent,并确保其存在。
function resolveSafeWorkspaceRoot(workspacePath) {
  if (workspacePath && existsSync(workspacePath)) return workspacePath;
  const defaultDir = path.join(os.homedir(), 'PeerAgent');
  if (!existsSync(defaultDir)) {
    mkdirSync(defaultDir, { recursive: true });
  }
  return defaultDir;
}

export function resolveProjectedModelToolCall({
  name,
  args,
  toolCallId,
  registry = DEFAULT_TOOL_REGISTRY,
  runtimeProjection = DEFAULT_RUNTIME_PROJECTION,
}) {
  const tool = registry.getTool(name);
  if (!tool) {
    return {
      ok: false,
      error: `Unknown tool: ${name}`,
    };
  }

  const capabilityId = executorCapabilityId(tool);
  const capability = (runtimeProjection?.capabilities ?? []).find(
    (candidate) => candidate.name === name && candidate.capabilityId === capabilityId,
  );
  if (!capability) {
    return {
      ok: false,
      error: `Tool ${name} is not available in the current Runtime Projection.`,
    };
  }

  return {
    ok: true,
    tool,
    capability,
    call: {
      toolCallId: toolCallId || `projected-tool:${randomUUID()}`,
      capabilityId: capability.capabilityId,
      toolName: name,
      arguments: args,
      argumentsPreview: args,
      reason: `Model requested ${name}.`,
      riskLevel: capability.riskLevel,
      dataLevel: capability.dataLevel,
      occurredAt: nowIso(),
    },
  };
}

function materializeShellExecution({ name, args, workspacePath, execution }) {
  const outputPreview = execution?.result?.outputPreview ?? {};
  const status = execution?.result?.status || outputPreview.status || 'failed';
  const localToolResultRef = outputPreview.localToolResultRef;
  if (localToolResultRef) {
    return {
      success: status === 'success',
      output: formatContextResult({
        tool: name,
        ...localToolResultRef,
      }),
    };
  }

  return {
    success: status === 'success',
    output: formatContextResult({
      kind: 'local_tool_result_ref',
      tool: name,
      command: args?.command ?? null,
      cwd: outputPreview.cwd ?? workspacePath,
      status,
      exitCode: outputPreview.exitCode ?? null,
      stdoutPreview: outputPreview.stdoutPreview ?? outputPreview.stdout ?? null,
      stderrPreview: outputPreview.stderrPreview ?? outputPreview.stderr ?? null,
      contextPreviewTruncated: Boolean(outputPreview.contextPreviewTruncated),
      reason: outputPreview.reason ?? execution?.result?.error ?? null,
    }),
  };
}

export function materializeProjectedToolExecution({
  name,
  args,
  workspacePath,
  execution,
}) {
  const result = execution?.result;
  const outputPreview = result?.outputPreview ?? {};
  if (outputPreview.legacyResult) return outputPreview.legacyResult;
  if (outputPreview.fileResult) return outputPreview.fileResult;
  if (name === 'bash') {
    return materializeShellExecution({ name, args, workspacePath, execution });
  }

  const status = result?.status || outputPreview.status || 'failed';
  return {
    success: status === 'success',
    output: formatContextResult({
      kind: 'local_capability_result_ref',
      tool: name,
      capabilityId: execution?.call?.capabilityId ?? null,
      status,
      outputPreview,
    }),
  };
}

export async function executeProjectedModelTool({
  name,
  args,
  workspacePath,
  toolContext = null,
  requestPermission,
  shellApprovalDecider,
  mcpRegistry = null,
  registry = DEFAULT_TOOL_REGISTRY,
  runtimeProjection = DEFAULT_RUNTIME_PROJECTION,
  locale = 'zh-CN',
  toolCallId = null,
  goalPlanStore = undefined,
}) {
  const projection = resolveProjectedModelToolCall({
    name,
    args,
    toolCallId,
    registry,
    runtimeProjection,
  });
  if (!projection.ok) {
    return { success: false, error: projection.error };
  }

  // Goal 模式运行时闸门（见 docs/proposals/0004-goal-mode-runtime-gate.md）：
  // 计划未获批准前，拒绝有副作用的能力，强制「先规划 → 批准 → 执行」。
  // 这是 PermissionGrant 之前的能力准入判定，不绕过 Runtime Projection。
  const gate = evaluateGoalModeGate({
    mode: toolContext?.mode ?? 'chat',
    toolName: name,
    riskLevel: projection.capability?.riskLevel,
    planGate: resolveGoalPlanGate(toolContext?.conversationId ?? null, goalPlanStore),
  });
  if (!gate.allowed) {
    return {
      ...buildGoalModeDenial({ name, reason: gate.reason, locale }),
      projectionCapability: projection.capability,
    };
  }

  const cwd = resolveSafeWorkspaceRoot(workspacePath);
  const userDataPath = getDataHome();
  const host = createLocalToolHost({
    workspaceRoot: cwd,
    userDataPath,
    sessionStore: createSessionStore(locale),
    mcpRegistry,
    shellProvider: createLocalShellProvider({
      workspaceRoot: cwd,
      userDataPath,
      artifactStore: shellArtifactStore,
      approvalDecider: shellApprovalDecider,
    }),
  });
  const execution = await host.execute({ call: projection.call }, {
    toolContext,
    requestPermission,
    locale,
  });
  return {
    ...materializeProjectedToolExecution({
      name,
      args,
      workspacePath: cwd,
      execution,
    }),
    execution,
    projectionCapability: projection.capability,
  };
}
