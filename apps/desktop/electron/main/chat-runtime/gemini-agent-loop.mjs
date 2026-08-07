import { sendGeminiStream } from '../provider-adapters/gemini-adapter.mjs';
import { countGeminiCanonicalRequest } from '../provider-adapters/context-count-adapter.mjs';
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
import { createGeminiVisualObservationParts } from './visual-observation-projection.mjs';

export async function agentLoopGemini({
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
  skillStore = null,
  goalPlanStore,
  automationProposalService = null,
  ensureBrowserReady = null,
  resolvedChannel = null,
  // Goal Runner 进度 sink：{ onRound } 每轮模型响应回调一次，用于实时轮次计数。
  agentProgress = null,
  emitRuntimeEvent = null,
  runtimeEventState = undefined,
  providerId = null,
  runtimeMode = 'chat',
  accountingIdentity = null,
  initialContextAccounting = null,
  authMethod = resolvedChannel?.authMethod ?? 'api_key',
}) {
  let effectiveSystemPrompt = systemPrompt;
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
    countCapability: authMethod === 'api_key'
      ? { kind: 'provider_count_api' }
      : { kind: 'observed_usage_only' },
  });
  const providerConfig = buildCompactionProviderConfig({
    provider: 'gemini',
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    resolvedChannel,
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
      initialize: () => ({ provider: 'gemini' }),
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
            // Goal 自驱：使用有界 keep，避免当前轮工具尾无限膨胀导致压缩失败。
            goalKeepPolicy: runtimeMode === 'goal' ? true : null,
            // Milestone C: Goal 压缩事务串需要 store 做 prepare/commit/persisted。
            goalPlanStore: runtimeMode === 'goal' ? goalPlanStore : null,
            runtimeUsageAccounting: loop.usageAccounting,
            onProviderRequest: ({ usage, requestFingerprint }) => {
              loop.addUsage(usage, { requestFingerprint });
            },
            rebuildSystemPrompt,
            accountingIdentity: accountingIdentity ?? {
              conversationId: conversationId || streamId,
              contentRevision: 0,
              modelKey: contextAccountingModelKey(providerId, model),
            },
            initialContextAccounting: loop.getContextAccounting(),
            countCapability: authMethod === 'api_key'
              ? { kind: 'provider_count_api' }
              : { kind: 'observed_usage_only' },
            ...(authMethod === 'api_key'
              ? {
                  countRequest: (canonicalRequest) => countGeminiCanonicalRequest({
                    baseUrl,
                    apiKey,
                    headers: resolvedChannel?.headers,
                    ...canonicalRequest,
                    maxOutputTokens,
                    signal,
                  }),
                }
              : {}),
            onContextAccounting: loop.acceptContextAccounting,
          },
          buildCanonicalRequest: ({ messages: projectedMessages }) => ({
            model,
            messages: sanitizeApiMessages(projectedMessages),
            tools,
            effort,
          }),
          send: (canonicalRequest) => sendGeminiStream({
            baseUrl,
            apiKey,
            endpoint: resolvedChannel?.endpoint,
            headers: resolvedChannel?.headers,
            ...canonicalRequest,
            supportsReasoning: Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning),
            maxOutputTokens,
            authMethod,
            projectId: resolvedChannel?.oauthProjectId,
            userPromptId: streamId || conversationId || undefined,
            sessionId: conversationId || streamId || undefined,
            signal,
            webContents: loop.providerWebContents,
            streamId,
          }),
        });
        apiMessages = execution.messages;
        if (typeof execution.systemPrompt === 'string' && execution.systemPrompt.trim()) {
          effectiveSystemPrompt = execution.systemPrompt;
        }
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

        const { content, thinkingContent, toolCalls } = providerResponse;
        if (!toolCalls.length) {
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
          geminiContent: {
            role: 'model',
            parts: [
              ...(content ? [{ text: content }] : []),
              ...toolCalls.map((toolCall) => ({
                functionCall: {
                  name: toolCall.name,
                  args: JSON.parse(toolCall.arguments || '{}'),
                },
              })),
            ],
          },
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
        const functionResponses = executions.map((execution) => {
          const toolExecution = execution.result;
          if (toolExecution.aborted) throw createDesktopAbortError();
          return {
            functionResponse: {
              name: execution.call.name,
              response: { result: toolExecution.output },
            },
          };
        });
        const visualObservationParts = createGeminiVisualObservationParts(executions);
        const parts = [...functionResponses, ...visualObservationParts];
        apiMessages.push({
          role: 'tool',
          content: JSON.stringify(functionResponses),
          geminiContent: { role: 'user', parts },
        });
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
          skillStore,
          goalPlanStore,
          automationProposalService,
          ensureBrowserReady,
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
