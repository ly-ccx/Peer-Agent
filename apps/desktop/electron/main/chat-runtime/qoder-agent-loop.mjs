import { sendQoderPrivateStream } from '../provider-adapters/qoder-private-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import {
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  computeContextInfo,
  isPromptTooLongResponse,
} from './compaction-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import { executeDesktopProviderRequest } from './provider-request-coordinator.mjs';
import * as responseGuard from './response-guard.mjs';
import {
  createDesktopAbortError,
  runDesktopRuntimePipeline,
} from './runtime-pipeline-adapter.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

// Reasoning models and slow queues may pause SSE longer than a short chat idle window.
// Keep a hard cap so hung streams still fail, but avoid treating 30s thinking gaps as fatal.
export const QODER_STREAM_IDLE_TIMEOUT_MS = 120_000;

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
  modelOptions,
  modelOptionValues = {},
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
  persistCompaction = null,
  continuityContext = [],
  rebuildSystemPrompt = null,
  sendStream = sendQoderPrivateStream,
  emitRuntimeEvent = null,
  runtimeEventState = undefined,
  providerId = null,
  runtimeMode = 'chat',
}) {
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const providerConfig = buildCompactionProviderConfig({
    provider: 'qoder',
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    resolvedChannel,
  });
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    conversationId,
    onRound: agentProgress?.onRound,
    getContextInfo: ({ usageSnapshot = null } = {}) => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools,
      usageSnapshot,
    }),
    // per-turn 投影生命周期的稳定输入：tool_result / turn_complete 边界取当前 Runtime 会话。
    getProjectionInput: () => ({ messages: apiMessages, tools, contextWindow }),
  });

  await runDesktopRuntimePipeline({
    sessionId: conversationId || streamId,
    streamId,
    conversationId,
    mode: runtimeMode,
    providerId,
    modelId: model,
    maxTurns: loop.maxTurns,
    signal,
    emitRuntimeEvent,
    eventState: runtimeEventState,
    lifecycle: {
      toolResultsApplied: () => loop.publishToolResultProjection(),
    },
    model: {
      initialize: () => ({ provider: 'qoder-private' }),
      runTurn: async (state) => {
        const execution = await executeDesktopProviderRequest({
          request: {
            messages: apiMessages,
            systemPrompt,
            contextWindow,
            providerConfig,
            signal,
            persistCompaction,
            conversationId,
            streamId,
            webContents,
            continuityContext,
            tools,
            preserveLatestUserTurn: true,
            usageSnapshot: loop.getLastTurnUsage?.() ?? null,
            rebuildSystemPrompt,
            contextLifecycle: loop.contextLifecycle,
          },
          buildCanonicalRequest: ({ messages: projectedMessages }) => ({
            model,
            messages: sanitizeApiMessages(projectedMessages),
            tools,
            maxOutputTokens,
            modelOptions,
            modelOptionValues,
          }),
          send: (canonicalRequest) => sendStream({
            baseUrl,
            apiKey,
            endpoint: resolvedChannel?.endpoint,
            ...canonicalRequest,
            signal,
            webContents,
            streamId,
            bufferThinkingDeltas: false,
            emitBufferedThinkingDeltas: true,
            streamIdleTimeoutMs: QODER_STREAM_IDLE_TIMEOUT_MS,
          }),
        });
        apiMessages = execution.messages;
        if (execution.compacted) loop.clearLastTurnUsage?.();
        const providerResponse = execution.response;

        if (signal?.aborted) throw makeAbortError();
        loop.addUsage(providerResponse.streamUsage);
        if (!providerResponse.ok) {
          const errorText = providerResponse.errorText || '';
          if (isPromptTooLongResponse(providerResponse.status, errorText)) {
            loop.sendError(buildPromptTooLongRecoveryError({
              text: errorText,
              providerTracePath: providerResponse.providerTracePath,
              retryUsed: execution.retriedAfterOverflow,
            }));
          } else if (providerResponse.providerError) {
            loop.sendError(`${errorText || 'qoder_private_error'}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
          } else {
            loop.sendHttpError(providerResponse.status, errorText || 'qoder_private_error');
          }
          return { kind: 'completed', state, reason: 'provider_error' };
        }

        const content = providerResponse.content || '';
        const thinkingContent = providerResponse.thinkingContent || '';
        const toolCalls = Array.isArray(providerResponse.toolCalls) ? providerResponse.toolCalls : [];
        if (!toolCalls.length) {
          if (!content.trim() && thinkingContent.trim()) {
            if (loop.claimEmptyResponseRetry()) {
              apiMessages.push({ role: 'user', content: qoderThinkingOnlyResponseCorrection() });
              return { kind: 'continue', state };
            }
            loop.sendError(qoderThinkingOnlyResponseError({
              providerTracePath: providerResponse.providerTracePath,
            }));
            return { kind: 'completed', state, reason: 'thinking_only_response' };
          }
          const terminalResponse = handleTerminalTextResponse({
            text: content,
            thinking: thinkingContent,
            providerTracePath: providerResponse.providerTracePath,
            apiMessages,
            loop,
            responseGuard,
          });
          return terminalResponse.action === 'retry'
            ? { kind: 'continue', state }
            : { kind: 'completed', state, reason: terminalResponse.reason };
        }

        apiMessages.push({
          role: 'assistant',
          content: content || null,
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments },
          })),
        });
        return {
          kind: 'tool_calls',
          state,
          calls: toolCalls.map((toolCall) => ({
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            payload: toolCall,
          })),
        };
      },
      applyToolResults: (state, executions) => {
        for (const execution of executions) {
          const toolExecution = execution.result;
          if (toolExecution.aborted) throw createDesktopAbortError();
          apiMessages.push({
            role: 'tool',
            tool_call_id: execution.call.toolCallId,
            content: toolExecution.output,
          });
        }
        return state;
      },
      onStopped: () => loop.sendDone(),
      onExhausted: () => loop.sendLoopExhausted(),
    },
    tools: {
      execute: async (call) => {
        const toolExecution = await executeModelToolCall({
          name: call.name,
          rawArguments: call.arguments,
          toolCallId: call.toolCallId,
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
        if (toolExecution.aborted) throw createDesktopAbortError();
        // terminal 工具（goal_create_plan / request_user_input 等）不得在这里 sendDone：
        // 必须先走 applyToolResults 写入 tool result，再由 pipeline onStopped 统一收尾，
        // 否则 done 快照会丢掉本轮 tool result，右下角占用会卡在发送前 seed。
        return {
          call,
          result: toolExecution,
          terminal: Boolean(toolExecution.controlSignal?.terminal),
          terminalReason: toolExecution.controlSignal?.reason || 'waiting_user',
        };
      },
    },
  });
}
