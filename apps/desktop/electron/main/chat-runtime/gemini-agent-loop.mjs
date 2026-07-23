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
  isPromptTooLongResponse,
  runCompactionCheck,
} from './compaction-coordinator.mjs';
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
        const compaction = await runCompactionCheck({
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
          const promptTooLong = isPromptTooLongResponse(providerResponse.status, text);
          if (promptTooLong && !promptTooLongRetryUsed) {
            const emergencyCompaction = await runCompactionCheck({
              messages: apiMessages,
              systemPrompt: effectiveSystemPrompt,
              contextWindow,
              providerConfig,
              signal,
              persistCompaction,
              conversationId,
              streamId,
              webContents,
              emergency: true,
              force: true,
              continuityContext,
              tools,
              preserveLatestUserTurn: true,
              rebuildSystemPrompt,
        });
            if (emergencyCompaction.compacted) {
              apiMessages = emergencyCompaction.messages;
              if (typeof emergencyCompaction.systemPrompt === 'string' && emergencyCompaction.systemPrompt.trim()) {
                effectiveSystemPrompt = emergencyCompaction.systemPrompt;
              }
              promptTooLongRetryUsed = true;
              return { kind: 'continue', state };
            }
          }
          if (promptTooLong) {
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
        // goal_create_plan / request_user_input 等 terminal 工具：立即 sendDone，
        // 不依赖后续 pipeline onStopped 时序，避免 UI 卡在「正在思考」。
        if (toolExecution.controlSignal?.terminal) {
          try { loop.sendDone(); } catch {}
        }
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
