import { sendQoderPrivateStream } from '../provider-adapters/qoder-private-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import { computeContextInfo } from './compaction-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import * as responseGuard from './response-guard.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeLiteralToolArguments(raw) {
  const args = raw?.input ?? raw?.args ?? raw?.arguments ?? raw?.parameters ?? raw?.function?.arguments ?? {};
  if (typeof args === 'string') return args;
  if (args && typeof args === 'object') return JSON.stringify(args);
  return '{}';
}

export function parseQoderLiteralToolCalls(text) {
  const value = String(text || '').trim();
  if (!value || !value.includes('<tool_call')) return [];
  const calls = [];
  let remainder = value;
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    remainder = remainder.replace(match[0], '');
    try {
      const parsed = JSON.parse(match[1]);
      const name = String(parsed?.name || parsed?.tool || parsed?.function?.name || '').trim();
      if (!name) return [];
      calls.push({
        id: String(parsed?.id || `qoder_literal_tool_${calls.length + 1}`),
        name,
        arguments: normalizeLiteralToolArguments(parsed),
      });
    } catch {
      return [];
    }
  }
  return calls.length > 0 && !remainder.trim() ? calls : [];
}

export async function agentLoopQoder({
  baseUrl,
  apiKey,
  model = 'Auto',
  systemPrompt,
  messages,
  tools = [],
  webContents,
  streamId,
  signal,
  contextWindow,
  conversationId,
  toolContext,
  workspacePath,
  permissionGate,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
  agentProgress = null,
  maxOutputTokens = 0,
  resolvedChannel = null,
  sendStream = sendQoderPrivateStream,
}) {
  const apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    getContextInfo: () => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools,
    }),
  });

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    const providerResponse = await sendStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      model,
      messages: sanitizeApiMessages(apiMessages),
      tools,
      maxOutputTokens,
      signal,
      webContents,
      streamId,
    });

    if (signal?.aborted) throw makeAbortError();
    loop.addUsage(providerResponse.streamUsage);
    if (!providerResponse.ok) {
      if (providerResponse.providerError) {
        loop.sendError(`${providerResponse.errorText || 'qoder_private_error'}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
        return;
      }
      loop.sendHttpError(providerResponse.status, providerResponse.errorText || 'qoder_private_error');
      return;
    }

    const content = providerResponse.content || '';
    const thinkingContent = providerResponse.thinkingContent || '';
    const toolCalls = Array.isArray(providerResponse.toolCalls) && providerResponse.toolCalls.length
      ? providerResponse.toolCalls
      : parseQoderLiteralToolCalls(content);

    if (!toolCalls.length) {
      const terminalResponse = handleTerminalTextResponse({
        text: content,
        thinking: thinkingContent,
        providerTracePath: providerResponse.providerTracePath,
        apiMessages,
        loop,
        responseGuard,
      });
      if (terminalResponse.action === 'retry') continue;
      return;
    }

    apiMessages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    let terminalControlSignal = null;
    for (const tc of toolCalls) {
      const toolExecution = await executeModelToolCall({
        name: tc.name,
        rawArguments: tc.arguments,
        toolCallId: tc.id,
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
      });
      if (toolExecution.aborted) return;
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolExecution.output });
      if (toolExecution.controlSignal?.terminal) terminalControlSignal = toolExecution.controlSignal;
    }

    if (terminalControlSignal) {
      loop.sendDone();
      return;
    }
  }

  loop.sendLoopExhausted();
}
