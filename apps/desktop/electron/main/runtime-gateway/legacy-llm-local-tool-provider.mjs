import { randomUUID } from 'node:crypto';
import { createLocalFileProvider } from './local-file-provider.mjs';
import { createLocalShellProvider } from './local-shell-provider.mjs';
import { createPermissionGrant, nowIso } from './tool-result-factory.mjs';

const TOOL_TO_CAPABILITY = {
  bash: 'legacy.local.shell.exec',
  read_file: 'legacy.local.file.read',
  search_files: 'legacy.local.file.search',
  edit_file: 'legacy.local.file.edit',
  write_file: 'legacy.local.file.write',
};

const TOOL_TO_LOCAL_FILE_CAPABILITY = {
  read_file: 'local.file.read',
  search_files: 'local.file.search',
  edit_file: 'local.file.edit',
  write_file: 'local.file.write',
};

function formatContextResult(payload) {
  return JSON.stringify(payload, null, 2);
}

function readLegacyArgs(call) {
  if (call.arguments && typeof call.arguments === 'object') return call.arguments;
  if (typeof call.arguments === 'string') {
    try {
      return JSON.parse(call.arguments);
    } catch {
      return {};
    }
  }
  return {};
}

function materializeShellProviderResult({ command, cwd, execution }) {
  const result = execution?.result ?? {};
  const outputPreview = result.outputPreview ?? {};
  const localToolResultRef = outputPreview.localToolResultRef;
  if (localToolResultRef) {
    return {
      success: result.status === 'success',
      output: formatContextResult({
        tool: 'bash',
        ...localToolResultRef,
      }),
    };
  }

  const status = result.status || 'failed';
  const reason = outputPreview.reason || result.error || 'shell capability failed';
  return {
    success: status === 'success',
    output: formatContextResult({
      kind: 'local_tool_result_ref',
      tool: 'bash',
      command,
      cwd,
      status,
      exitCode: outputPreview.exitCode ?? null,
      stdoutPreview: outputPreview.stdoutPreview ?? outputPreview.stdout ?? null,
      stderrPreview: outputPreview.stderrPreview ?? outputPreview.stderr ?? reason,
      contextPreviewTruncated: Boolean(outputPreview.contextPreviewTruncated),
      reason,
    }),
  };
}

async function executeLocalShellLegacy({
  args,
  cwd,
  artifactStore,
  shellProvider,
  shellApprovalDecider,
  locale,
}) {
  const provider = shellProvider ?? createLocalShellProvider({
    workspaceRoot: cwd,
    artifactStore,
    approvalDecider: shellApprovalDecider,
  });
  const command = typeof args.command === 'string' ? args.command : '';
  const call = {
    toolCallId: `legacy-shell:${randomUUID()}`,
    capabilityId: 'local.shell.exec',
    toolName: 'bash',
    arguments: { command },
    argumentsPreview: { command },
    occurredAt: nowIso(),
  };
  const execution = await provider.executeCapability({ call }, {
    workspaceRoot: cwd,
    locale,
  });
  return materializeShellProviderResult({ command, cwd, execution });
}

async function executeLocalFileLegacy({ name, args, cwd, toolContext, requestPermission, fileProvider, locale }) {
  const capabilityId = TOOL_TO_LOCAL_FILE_CAPABILITY[name];
  if (!capabilityId) return null;
  const provider = fileProvider ?? createLocalFileProvider({ workspaceRoot: cwd });
  const call = {
    toolCallId: `legacy-file:${randomUUID()}`,
    capabilityId,
    toolName: name,
    arguments: args,
    argumentsPreview: args,
    occurredAt: nowIso(),
  };
  const execution = await provider.executeCapability({ call }, {
    workspaceRoot: cwd,
    toolContext,
    requestPermission,
    locale,
  });
  return execution?.result?.outputPreview?.legacyResult ?? {
    success: false,
    error: `Local file capability did not return a legacy-compatible result: ${capabilityId}`,
  };
}

async function runLegacyTool({
  name,
  args,
  cwd,
  toolContext,
  requestPermission,
  artifactStore,
  fileProvider,
  shellProvider,
  shellApprovalDecider,
  locale,
}) {
  try {
    if (name === 'bash') {
      return await executeLocalShellLegacy({
        args,
        cwd,
        artifactStore,
        shellProvider,
        shellApprovalDecider,
        locale,
      });
    }
    if (TOOL_TO_LOCAL_FILE_CAPABILITY[name]) {
      return await executeLocalFileLegacy({
        name,
        args,
        cwd,
        toolContext,
        requestPermission,
        fileProvider,
        locale,
      });
    }
    return { success: false, error: `Unknown tool: ${name}` };
  } catch (err) {
    return { success: false, error: err?.message || 'execution failed', stderr: err?.stderr?.slice?.(0, 4000) };
  }
}

function statusFromLegacyResult(legacyResult) {
  if (legacyResult.success) return 'success';
  try {
    const parsed = JSON.parse(legacyResult.output || '{}');
    return parsed.status === 'blocked' ? 'denied' : (parsed.status || 'failed');
  } catch {
    return 'failed';
  }
}

function dataLevelForTool(name) {
  if (name === 'bash') return 'D2_sensitive';
  if (name === 'read_file') return 'D1_internal';
  return 'D2_sensitive';
}

function buildCapabilityResult({ call, name, locale, legacyResult }) {
  const status = statusFromLegacyResult(legacyResult);
  const dataLevel = dataLevelForTool(name);
  return {
    toolCallId: call.toolCallId,
    status,
    outputPreview: {
      status,
      tool: name,
      legacyResult,
    },
    evidence: {
      evidenceId: randomUUID(),
      toolCallId: call.toolCallId,
      summary: locale === 'zh-CN'
        ? `本地 legacy LLM 工具 ${name} 执行完成，状态：${status}。`
        : `Local legacy LLM tool ${name} completed with status ${status}.`,
      locale,
      returnedToCloud: false,
      dataLevel,
      redactions: [],
      artifactRefs: [],
    },
    completedAt: nowIso(),
  };
}

export function createLegacyLlmLocalToolProvider({ artifactStore, fileProvider, shellProvider, shellApprovalDecider } = {}) {
  async function executeCapability(request, context = {}) {
    const call = request.call;
    const name = Object.entries(TOOL_TO_CAPABILITY)
      .find(([, capabilityId]) => capabilityId === call.capabilityId)?.[0];
    if (!name) return null;
    const args = readLegacyArgs(call);
    const cwd = context.workspaceRoot || process.cwd();
    const legacyResult = await runLegacyTool({
      name,
      args,
      cwd,
      toolContext: context.toolContext,
      requestPermission: context.requestPermission,
      artifactStore,
      fileProvider,
      shellProvider,
      shellApprovalDecider: context.shellApprovalDecider ?? shellApprovalDecider,
      locale: context.locale ?? 'zh-CN',
    });
    const status = statusFromLegacyResult(legacyResult);
    const grant = createPermissionGrant({
      toolCallId: call.toolCallId,
      granted: status !== 'denied',
      scope: call.capabilityId,
      duration: status !== 'denied' ? 'once' : 'denied',
    });
    return {
      call,
      grant,
      result: buildCapabilityResult({
        call,
        name,
        locale: context.locale ?? 'zh-CN',
        legacyResult,
      }),
    };
  }

  return {
    providerId: 'legacy.llm.local-tools',
    capabilityIds: Object.values(TOOL_TO_CAPABILITY),
    executeCapability,
  };
}

export async function executeLegacyLlmLocalTool({
  name,
  args,
  workspacePath,
  toolContext = null,
  requestPermission,
  artifactStore,
  shellApprovalDecider,
  locale = 'zh-CN',
}) {
  const capabilityId = TOOL_TO_CAPABILITY[name];
  if (!capabilityId) return { success: false, error: `Unknown tool: ${name}` };
  const provider = createLegacyLlmLocalToolProvider({ artifactStore, shellApprovalDecider });
  const call = {
    toolCallId: `legacy-llm:${randomUUID()}`,
    capabilityId,
    toolName: name,
    arguments: args,
    argumentsPreview: args,
    occurredAt: nowIso(),
  };
  const execution = await provider.executeCapability({ call }, {
    workspaceRoot: workspacePath || process.cwd(),
    toolContext,
    requestPermission,
    locale,
  });
  return execution.result.outputPreview.legacyResult;
}
