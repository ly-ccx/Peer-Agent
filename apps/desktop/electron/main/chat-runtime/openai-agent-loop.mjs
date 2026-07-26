import {
  sendOpenAIChatStream,
  shouldUsePublicOpenAIChatStream,
} from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
import { contextAccountingModelKey } from '@peer-agent/protocol';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import {
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  isPromptTooLongResponse,
} from './compaction-coordinator.mjs';
import { executeDesktopProviderRequest } from './provider-request-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import * as responseGuard from './response-guard.mjs';
import {
  createDesktopAbortError,
  runDesktopRuntimePipeline,
} from './runtime-pipeline-adapter.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

export async function agentLoopOpenAI({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  messages,
  tools,
  webContents,
  streamId,
  signal,
  effort,
  supportsReasoning = false,
  supportsPromptCaching = false,
  contextWindow,
  maxOutputTokens,
  conversationId,
  persistCompaction,
  continuityContext = [],
  rebuildSystemPrompt = null,
  toolContext,
  workspacePath,
  permissionGate,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
  onNativeReasoningFallback = null,
  resolvedChannel = null,
  // ADR 28: ChatGPT 订阅链路走 Responses 传输,需附带 accountId。
  authMethod = 'api_key',
  accountId = null,
  // Goal Runner 进度 sink：{ onRound } 每轮模型响应回调一次，用于实时轮次计数。
  agentProgress = null,
  emitRuntimeEvent = null,
  runtimeEventState = undefined,
  providerId = null,
  runtimeMode = 'chat',
  accountingIdentity = null,
  initialContextAccounting = null,
}) {
  let effectiveSystemPrompt = systemPrompt;
  // 按鉴权方式选择 OpenAI 协议族的传输 adapter,保持循环逻辑统一。
  const useResponses = resolvedChannel?.wire === 'openai-responses' || authMethod === 'oauth_chatgpt';
  const sendStream = useResponses
    ? (args) => sendOpenAIResponsesStream({ ...args, accountId, omitMaxOutputTokens: authMethod === 'oauth_chatgpt' })
    : sendOpenAIChatStream;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: effectiveSystemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    conversationId,
    onRound: agentProgress?.onRound,
    emitRuntimeEvent,
    accountingIdentity: accountingIdentity ?? {
      conversationId: conversationId || streamId,
      contentRevision: 0,
      modelKey: contextAccountingModelKey(providerId, model),
    },
    initialContextAccounting,
    contextWindow,
    countCapability: { kind: 'observed_usage_only' },
  });
  const providerConfig = buildCompactionProviderConfig({
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    resolvedChannel,
    useResponses,
    authMethod,
  });
  let effectiveSupportsReasoning = Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning);

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
      initialize: () => ({ provider: 'openai' }),
      runTurn: async (state) => {
        const execution = await executeDesktopProviderRequest({
          request: {
            messages: apiMessages,
            systemPrompt: effectiveSystemPrompt,
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
            accountingIdentity: accountingIdentity ?? {
              conversationId: conversationId || streamId,
              contentRevision: 0,
              modelKey: contextAccountingModelKey(providerId, model),
            },
            initialContextAccounting: loop.getContextAccounting(),
            countCapability: { kind: 'observed_usage_only' },
            onContextAccounting: loop.acceptContextAccounting,
          },
          buildCanonicalRequest: ({ messages: projectedMessages }) => ({
            model,
            messages: sanitizeApiMessages(projectedMessages),
            tools,
            effort,
          }),
          send: (canonicalRequest) => sendStream({
            baseUrl,
            apiKey,
            endpoint: resolvedChannel?.endpoint,
            headers: resolvedChannel?.headers,
            ...canonicalRequest,
            supportsReasoning: effectiveSupportsReasoning,
            reasoningParamStyle: resolvedChannel?.reasoningParamStyle || 'openai-effort',
            reasoningEffortMap: resolvedChannel?.reasoningEffortMap,
            promptCaching: resolvedChannel?.supportsPromptCaching ?? supportsPromptCaching,
            maxOutputTokens,
            signal,
            webContents: loop.providerWebContents,
            streamId,
            usePublicStreamConsumer: shouldUsePublicOpenAIChatStream(resolvedChannel, useResponses),
          }),
        });
        apiMessages = execution.messages;
        if (typeof execution.systemPrompt === 'string' && execution.systemPrompt.trim()) {
          effectiveSystemPrompt = execution.systemPrompt;
        }
        if (execution.compacted) loop.clearLastTurnUsage?.();
        const providerResponse = execution.response;

        if (!providerResponse.ok) {
          const text = providerResponse.errorText || '';
          if (isPromptTooLongResponse(providerResponse.status, text)) {
            loop.sendError(buildPromptTooLongRecoveryError({
              text,
              providerTracePath: providerResponse.providerTracePath,
              retryUsed: execution.retriedAfterOverflow,
            }));
          } else if (providerResponse.providerError) {
            loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
          } else {
            loop.sendHttpError(providerResponse.status, text);
          }
          return { kind: 'completed', state, reason: 'provider_error' };
        }

        const { content, thinkingContent, toolCalls, streamUsage } = providerResponse;
        loop.addUsage(streamUsage);
        if (!toolCalls.length) {
          if (
            effectiveSupportsReasoning &&
            (effort === 'high' || effort === 'xhigh') &&
            !String(content || '').trim() &&
            !String(thinkingContent || '').trim()
          ) {
            effectiveSupportsReasoning = false;
            onNativeReasoningFallback?.({ provider: 'openai', reason: 'empty_response' });
            return { kind: 'continue', state };
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
          // 必须为每个 tool_call 写回配对的 tool message，再决定是否终止。
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
