import { executeProjectedModelTool } from './projected-tool-executor.mjs';

export function createToolContext({ conversationId = null, workspacePath = null, mode = 'chat' } = {}) {
  return {
    conversationId,
    workspacePath,
    // 当前回合的交互模式（chat/goal/...）。由 llm-chat-service 在每次 run 时写入，
    // 供 goal 模式运行时闸门在工具执行层判定准入。见 docs/proposals/0004-goal-mode-runtime-gate.md。
    mode,
    readFiles: new Map(),
  };
}

export function safeParseJson(value) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function materializeToolOutput(result) {
  return result.output || (result.success ? '' : `Error: ${result.error}${result.stderr ? '\n' + result.stderr : ''}`);
}

/**
 * 从一次工具执行结果中提取「回合控制信号」。
 * 目前唯一来源是无副作用的 interaction 能力（request_user_input），它在 Evidence 的
 * outputPreview.control 里标记 { terminal: true }，用于让 agent loop 在本回合收尾后
 * 停止回灌、把控制权交还给用户（而不是自行继续决策）。详见 local-interaction-provider.mjs。
 */
export function extractToolControlSignal(result) {
  const control = result?.execution?.result?.outputPreview?.control;
  if (control && typeof control === 'object' && control.terminal === true) {
    return { terminal: true, reason: control.reason ?? null };
  }
  return null;
}

export async function executeModelToolCall({
  name,
  rawArguments,
  toolCallId,
  workspacePath,
  toolContext,
  permissionGate,
  webContents,
  streamId,
  conversationId,
  signal,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
}) {
  const args = safeParseJson(rawArguments);
  webContents.send('chat:stream:tool-call', { streamId, tool: name, args, toolCallId });
  const requestFilePermission = permissionGate.createFilePermissionRequester({
    webContents,
    streamId,
    toolCallId,
    conversationId,
  });
  const requestLocalCapabilityPermission = permissionGate.createLocalCapabilityPermissionRequester({
    webContents,
    streamId,
    toolCallId,
    conversationId,
    workspacePath,
  });
  const result = await executeProjectedModelTool({
    name,
    args,
    workspacePath,
    toolContext,
    toolCallId,
    requestPermission: (request) => {
      if (request?.filePath || request?.tool || request?.workspacePath) return requestFilePermission(request);
      return requestLocalCapabilityPermission(request);
    },
    shellApprovalDecider: permissionGate.createShellApprovalDecider({
      webContents,
      streamId,
      toolCallId,
      conversationId,
      workspacePath,
    }),
    registry,
    runtimeProjection,
    mcpRegistry,
    goalPlanStore,
  });
  if (signal?.aborted) return { aborted: true, args, output: '' };
  const output = materializeToolOutput(result);
  webContents.send('chat:stream:tool-result', { streamId, toolCallId, result: output.slice(0, 4000) });
  const controlSignal = extractToolControlSignal(result);
  return { aborted: false, args, output, result, controlSignal };
}
