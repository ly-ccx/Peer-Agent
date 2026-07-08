import { sendQoderPrivateStream } from '../provider-adapters/qoder-private-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import { computeContextInfo } from './compaction-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import * as responseGuard from './response-guard.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

const QODER_STREAM_IDLE_TIMEOUT_MS = 30_000;

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function qoderThinkingOnlyResponseError({ providerTracePath = null } = {}) {
  const suffix = providerTracePath ? ` provider_trace=${providerTracePath}` : '';
  return `qoder_thinking_only_response: Qoder returned reasoning-only output without final text or a valid tool call.${suffix}`;
}

function qoderThinkingOnlyResponseCorrection() {
  return [
    'The previous Qoder response contained only hidden reasoning and no final answer or valid tool call.',
    'Discard that reasoning-only output.',
    'If the task requires local filesystem, git, shell, build, runtime, or verification facts, emit an actual tool call now.',
    'Otherwise provide a final text answer. Do not stop after a planning or tool-use preamble.',
  ].join(' ');
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
    const requestMessages = sanitizeApiMessages(apiMessages);
    const providerResponse = await sendStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      model,
      messages: requestMessages,
      tools,
      maxOutputTokens,
      signal,
      webContents,
      streamId,
      bufferThinkingDeltas: false,
      emitBufferedThinkingDeltas: true,
      streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
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
    const toolCalls = Array.isArray(providerResponse.toolCalls) ? providerResponse.toolCalls : [];

    if (!toolCalls.length) {
      if (!content.trim() && thinkingContent.trim()) {
        if (loop.claimEmptyResponseRetry()) {
          apiMessages.push({
            role: 'user',
            content: qoderThinkingOnlyResponseCorrection(),
          });
          continue;
        }
        loop.sendError(qoderThinkingOnlyResponseError({
          providerTracePath: providerResponse.providerTracePath,
        }));
        return;
      }
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
