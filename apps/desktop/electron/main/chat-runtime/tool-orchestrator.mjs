import { executeProjectedModelTool } from './projected-tool-executor.mjs';

export function createToolContext({ conversationId = null, workspacePath = null, mode = 'chat' } = {}) {
  return {
    conversationId,
    workspacePath,
    // 当前回合的交互模式（chat/goal/...）。由 llm-chat-service 在每次 run 时写入，
    // 供 goal 模式运行时闸门在工具执行层判定准入。见 Goal 模式运行时闸门设计。
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

const REQUEST_USER_INPUT_TOOL = 'request_user_input';

function isRequestUserInputTool(name) {
  return name === REQUEST_USER_INPUT_TOOL || (typeof name === 'string' && name.endsWith(`.${REQUEST_USER_INPUT_TOOL}`));
}

export function formatToolResultForStream({ name, args, output }) {
  if (!isRequestUserInputTool(name)) return output.slice(0, 4000);
  const question = typeof args?.question === 'string' ? args.question.trim() : '';
  if (!question) return output.slice(0, 4000);
  const options = Array.isArray(args?.options)
    ? args.options.filter((option) => typeof option === 'string' && option.trim()).map((option) => option.trim())
    : [];
  const note = typeof args?.note === 'string' ? args.note.trim() : undefined;
  return JSON.stringify({
    ok: true,
    acknowledged: true,
    question,
    options,
    ...(note ? { note } : {}),
  });
}

/**
 * 从 Runtime Projection 按 capability name 反查后端注入的展示文案 displayName。
 * 用于把工具卡标题（尤其是 MCP 工具的「服务名: 工具名」）随 tool-call 事件透传给表达层。
 * 找不到时返回 null，由渲染层回退到裸 capability 名，保持既有行为不被破坏。
 */
export function resolveCapabilityDisplayName(runtimeProjection, name) {
  const capability = (runtimeProjection?.capabilities ?? []).find(
    (candidate) => candidate?.name === name,
  );
  const displayName = capability?.displayName;
  return typeof displayName === 'string' && displayName.length > 0 ? displayName : null;
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
  // displayName 是后端 Runtime Projection 注入的固定展示文案（MCP 工具为
  // 「服务名: 工具名」），表达层用它渲染工具卡标题。这里按 name 从投影反查并随
  // tool-call 事件透传，避免渲染层只能显示裸 capability 名（如 mcp__server__tool）。
  const displayName = resolveCapabilityDisplayName(runtimeProjection, name);
  webContents.send('chat:stream:tool-call', { streamId, tool: name, displayName, args, toolCallId });
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
  const streamResult = formatToolResultForStream({ name, args, output });
  webContents.send('chat:stream:tool-result', { streamId, toolCallId, result: streamResult });
  const controlSignal = extractToolControlSignal(result);
  return { aborted: false, args, output, result, controlSignal };
}
