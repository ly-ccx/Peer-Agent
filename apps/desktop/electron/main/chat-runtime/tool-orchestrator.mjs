import { executeProjectedModelTool } from './projected-tool-executor.mjs';

export function createToolContext({ conversationId = null, workspacePath = null } = {}) {
  return {
    conversationId,
    workspacePath,
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
}) {
  const args = safeParseJson(rawArguments);
  webContents.send('chat:stream:tool-call', { streamId, tool: name, args, toolCallId });
  const result = await executeProjectedModelTool({
    name,
    args,
    workspacePath,
    toolContext,
    toolCallId,
    requestPermission: permissionGate.createFilePermissionRequester({
      webContents,
      streamId,
      toolCallId,
      conversationId,
    }),
    shellApprovalDecider: permissionGate.createShellApprovalDecider({
      webContents,
      streamId,
      toolCallId,
      conversationId,
      workspacePath,
    }),
  });
  if (signal?.aborted) return { aborted: true, args, output: '' };
  const output = materializeToolOutput(result);
  webContents.send('chat:stream:tool-result', { streamId, toolCallId, result: output.slice(0, 4000) });
  return { aborted: false, args, output, result };
}
