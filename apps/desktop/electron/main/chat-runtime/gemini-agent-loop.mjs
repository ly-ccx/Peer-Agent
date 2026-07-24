import { sendGeminiStream } from '../provider-adapters/gemini-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import {
  applyMicrocompaction,
  buildCompactionProviderConfig,
  buildPromptTooLongRecoveryError,
  computeContextInfo,
} from './compaction-coordinator.mjs';
import {
  coordinateDesktopProviderRequest,
  recoverFromPromptTooLong,
} from './provider-request-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';
import * as responseGuard from './response-guard.mjs';
import {
  createDesktopAbortError,
  runDesktopRuntimePipeline,
} from './runtime-pipeline-adapter.mjs';
import { executeModelToolCall } from './tool-orchestrator.mjs';

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
  goalPlanStore,
  resolvedChannel = null,
  // Goal Runner 进度 sink：{ onRound } 每轮模型响应回调一次，用于实时轮次计数。
  agentProgress = null,
  emitRuntimeEvent = null,
  runtimeEventState = undefined,
  providerId = null,
  runtimeMode = 'chat',
}) {
  let effectiveSystemPrompt = systemPrompt;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: effectiveSystemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    conversationId,
    onRound: agentProgress?.onRound,
    // ADR 52：右下角 / done 快照必须投影「下一请求」输入量。
    // 用当前 Runtime apiMessages（含本轮最终 assistant / tool result + system），
    // 由 computeContextInfo 做 Layer 1 微压缩投影；不得回退到上一轮 lastSent 切片。
    // usageSnapshot 仅作诊断校准，不锁死下一请求预算。
    getContextInfo: ({ usageSnapshot = null } = {}) => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools,
      usageSnapshot,
    }),
    // per-turn 投影生命周期的稳定输入：tool_result / turn_complete 边界取当前 Runtime 会话。
    getProjectionInput: () => ({ messages: apiMessages, tools, contextWindow }),
  });
  const providerConfig = buildCompactionProviderConfig({
    provider: 'gemini',
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    resolvedChannel,
  });
  let promptTooLongRetryUsed = false;

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
    model: {
      initialize: () => ({ provider: 'gemini' }),
      runTurn: async (state) => {
        const compaction = await coordinateDesktopProviderRequest({
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
          // usageSnapshot 仅诊断/校准；soft 触发以当前下一请求投影为准。
          usageSnapshot: loop.getLastTurnUsage?.() ?? null,
          rebuildSystemPrompt,
          contextLifecycle: loop.contextLifecycle,
        });
        if (compaction.compacted || compaction.microcompacted) {
          apiMessages = compaction.messages;
          if (typeof compaction.systemPrompt === 'string' && compaction.systemPrompt.trim()) {
            effectiveSystemPrompt = compaction.systemPrompt;
          }
          // 语义压缩或静默微压缩后，清掉陈旧 usage，避免压缩前高水位继续锁死显示/触发。
          loop.clearLastTurnUsage?.();
        }

        // Provider adapter 只接收实际发送切片；完整历史仍由 Desktop Model Adapter 持有。
        // 下一请求占用由 getContextInfo 基于当前 apiMessages 投影，不缓存 lastSent。
        const sendMessages = sanitizeApiMessages(applyMicrocompaction(apiMessages).messages);
        const providerResponse = await sendGeminiStream({
          baseUrl,
          apiKey,
          endpoint: resolvedChannel?.endpoint,
          headers: resolvedChannel?.headers,
          model,
          messages: sendMessages,
          tools,
          effort,
          supportsReasoning: Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning),
          maxOutputTokens,
          authMethod: resolvedChannel?.authMethod,
          projectId: resolvedChannel?.oauthProjectId,
          userPromptId: streamId || conversationId || undefined,
          sessionId: conversationId || streamId || undefined,
          signal,
          webContents,
          streamId,
        });

        if (!providerResponse.ok) {
          const text = providerResponse.errorText || '';
          // PTL 分类与 emergency 重试策略收敛到共享 helper（同一请求最多重试一次）。
          const recovery = await recoverFromPromptTooLong({
            status: providerResponse.status,
            errorText: text,
            retryUsed: promptTooLongRetryUsed,
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
              rebuildSystemPrompt,
              contextLifecycle: loop.contextLifecycle,
            },
          });
          if (recovery.retried) {
            apiMessages = recovery.messages;
            if (recovery.systemPrompt) effectiveSystemPrompt = recovery.systemPrompt;
            promptTooLongRetryUsed = true;
            return { kind: 'continue', state };
          }
          if (recovery.promptTooLong) {
            loop.sendError(buildPromptTooLongRecoveryError({
              text,
              providerTracePath: providerResponse.providerTracePath,
              retryUsed: promptTooLongRetryUsed,
            }));
          } else if (providerResponse.providerError) {
            loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
          } else {
            loop.sendHttpError(providerResponse.status, text);
          }
          return { kind: 'completed', state, reason: 'provider_error' };
        }
        promptTooLongRetryUsed = false;

        const { content, thinkingContent, toolCalls, streamUsage } = providerResponse;
        loop.addUsage(streamUsage);
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
        apiMessages.push({
          role: 'tool',
          content: JSON.stringify(functionResponses),
          geminiContent: { role: 'user', parts: functionResponses },
        });
        // 稳定边界：tool result 已写入 Runtime 会话，发布 tool_result 投影替换流式预览。
        loop.publishToolResultProjection();
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
