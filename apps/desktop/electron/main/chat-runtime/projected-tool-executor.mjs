import { randomUUID } from 'node:crypto';
import { getDataHome } from '../data-store.mjs';
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
  registry = DEFAULT_TOOL_REGISTRY,
  runtimeProjection = DEFAULT_RUNTIME_PROJECTION,
  locale = 'zh-CN',
  toolCallId = null,
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

  const cwd = workspacePath || process.cwd();
  const userDataPath = getDataHome();
  const host = createLocalToolHost({
    workspaceRoot: cwd,
    userDataPath,
    sessionStore: createSessionStore(locale),
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
