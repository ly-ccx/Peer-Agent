import {
  sendOpenAIChatStream,
  shouldUsePublicOpenAIChatStream,
} from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
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
}) {
  let effectiveSystemPrompt = systemPrompt;
  // 按鉴权方式选择 OpenAI 协议族的传输 adapter,保持循环逻辑统一。
  const useResponses = resolvedChannel?.wire === 'openai-responses' || authMethod === 'oauth_chatgpt';
  const sendStream = useResponses
    ? (args) => sendOpenAIResponsesStream({ ...args, accountId, omitMaxOutputTokens: authMethod === 'oauth_chatgpt' })
    : sendOpenAIChatStream;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: effectiveSystemPrompt }, ...messages]);
  // 最后一轮「实际发送切片」（微压缩+清洗后真正发给 provider 的消息，已含 system）。供
  // getContextInfo 实际发送量在 provider usage 缺失时回退估算之用；不参与压缩触发判定。
  let lastSentMessages = null;
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // 触发口径按「当前 Runtime apiMessages」（已含 system）判定；实际发送量优先采用 kernel
    // 传入的 provider 真实 usage 快照（最后一轮 input+cacheRead），
    // 其次回退到对「最后一轮实际发送切片」的估算，最后回退完整会话估算。
    getContextInfo: ({ usageSnapshot = null } = {}) => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools,
      displayMessages: lastSentMessages,
      usageSnapshot,
    }),
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
      initialize: () => ({ provider: 'openai' }),
      runTurn: async (state) => {
        // 自动 preflight 压缩：触发判定按完整 apiMessages 估算；切分时保留最新真人 user turn，
        // 避免用户刚发送的原文被 compaction summary 代替。
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
          // 对齐进度条：上一轮真实 usage 高水位也参与 soft 触发。
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
        const sendMessages = sanitizeApiMessages(applyMicrocompaction(apiMessages).messages);
        lastSentMessages = sendMessages;
        const providerResponse = await sendStream({
          baseUrl,
          apiKey,
          endpoint: resolvedChannel?.endpoint,
          headers: resolvedChannel?.headers,
          model,
          messages: sendMessages,
          tools,
          effort,
          supportsReasoning: effectiveSupportsReasoning,
          reasoningParamStyle: resolvedChannel?.reasoningParamStyle || 'openai-effort',
          reasoningEffortMap: resolvedChannel?.reasoningEffortMap,
          promptCaching: resolvedChannel?.supportsPromptCaching ?? supportsPromptCaching,
          maxOutputTokens,
          signal,
          webContents,
          streamId,
          usePublicStreamConsumer: shouldUsePublicOpenAIChatStream(resolvedChannel, useResponses),
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
