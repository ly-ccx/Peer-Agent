import { sendAnthropicMessagesStream } from '../provider-adapters/anthropic-messages-adapter.mjs';
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
import {
  executeModelToolCall,
  safeParseJson,
} from './tool-orchestrator.mjs';

export async function agentLoopAnthropic({
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
  toolContext,
  workspacePath,
  permissionGate,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
  onNativeReasoningFallback = null,
  resolvedChannel = null,
  // Goal Runner 进度 sink：{ onRound } 每轮模型响应回调一次，用于实时轮次计数。
  agentProgress = null,
  emitRuntimeEvent = null,
  runtimeEventState = undefined,
  providerId = null,
  runtimeMode = 'chat',
}) {
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  // 最后一轮「实际发送切片」（微压缩+清洗后真正发给 provider 的消息）。供 getContextInfo
  // 显示口径在 provider usage 缺失时回退估算之用；不参与压缩触发判定。
  let lastSentMessages = null;
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // 口径分离（ADR 42）：触发口径仍按「完整会话 apiMessages + system」判定，保持压缩时机不变；
    // 显示口径优先采用 kernel 传入的 provider 真实 usage 快照（最后一轮 input+cacheRead，压缩后回落），
    // 其次回退到对「最后一轮实际发送切片」的估算，最后回退完整会话估算。
    getContextInfo: ({ usageSnapshot = null } = {}) => computeContextInfo({
      messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
      contextWindow,
      tools,
      displayMessages: lastSentMessages
        ? [{ role: 'system', content: effectiveSystem }, ...lastSentMessages]
        : null,
      usageSnapshot,
    }),
  });
  const providerConfig = buildCompactionProviderConfig({
    provider: 'anthropic',
    baseUrl,
    apiKey,
    model,
    maxOutputTokens,
    resolvedChannel,
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
      initialize: () => ({ provider: 'anthropic' }),
      runTurn: async (state) => {
        const compaction = await runCompactionCheck({
          messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
          systemPrompt: effectiveSystem,
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
        });
        if (compaction.compacted || compaction.microcompacted) {
          effectiveSystem = compaction.messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n\n');
          apiMessages = compaction.messages.filter((message) => message.role !== 'system');
          // 语义压缩或静默微压缩后，清掉陈旧 usage，避免压缩前高水位继续锁死显示/触发。
          loop.clearLastTurnUsage?.();
        }

        const sendMessages = sanitizeApiMessages(applyMicrocompaction(apiMessages).messages);
        lastSentMessages = sendMessages;
        const providerResponse = await sendAnthropicMessagesStream({
          baseUrl,
          apiKey,
          endpoint: resolvedChannel?.endpoint,
          headers: resolvedChannel?.headers,
          model,
          system: effectiveSystem,
          messages: sendMessages,
          tools,
          effort,
          supportsReasoning: effectiveSupportsReasoning,
          reasoningParamStyle: resolvedChannel?.reasoningParamStyle,
          reasoningEffortMap: resolvedChannel?.reasoningEffortMap,
          promptCaching: resolvedChannel?.supportsPromptCaching ?? supportsPromptCaching,
          maxOutputTokens,
          signal,
          webContents,
          streamId,
        });

        if (!providerResponse.ok) {
          const text = providerResponse.errorText || '';
          const promptTooLong = isPromptTooLongResponse(providerResponse.status, text);
          if (promptTooLong && !promptTooLongRetryUsed) {
            const emergencyCompaction = await runCompactionCheck({
              messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
              systemPrompt: effectiveSystem,
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
            });
            if (emergencyCompaction.compacted) {
              effectiveSystem = emergencyCompaction.messages
                .filter((message) => message.role === 'system')
                .map((message) => message.content)
                .join('\n\n');
              apiMessages = emergencyCompaction.messages.filter((message) => message.role !== 'system');
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

        const {
          textContent,
          thinkingContent,
          thinkingSignature,
          toolUseBlocks,
          stopReason,
          streamUsage,
        } = providerResponse;
        loop.addUsage(streamUsage);
        const effectiveToolUseBlocks = stopReason === 'tool_use' ? toolUseBlocks : [];
        if (!effectiveToolUseBlocks.length) {
          if (
            effectiveSupportsReasoning &&
            effort === 'high' &&
            !String(textContent || '').trim() &&
            !String(thinkingContent || '').trim()
          ) {
            effectiveSupportsReasoning = false;
            onNativeReasoningFallback?.({ provider: 'anthropic', reason: 'empty_response' });
            return { kind: 'continue', state };
          }
          const terminalResponse = handleTerminalTextResponse({
            text: textContent,
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

        const assistantContent = [];
        // Anthropic 工具多轮要求带 signature 的 thinking block 位于 content 首位。
        if (thinkingSignature) {
          assistantContent.push({
            type: 'thinking',
            thinking: thinkingContent || '',
            signature: thinkingSignature,
          });
        }
        if (textContent) assistantContent.push({ type: 'text', text: textContent });
        for (const toolUse of effectiveToolUseBlocks) {
          assistantContent.push({
            type: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: safeParseJson(toolUse.inputJson),
          });
        }
        apiMessages.push({ role: 'assistant', content: assistantContent });
        return {
          kind: 'tool_calls',
          state,
          calls: effectiveToolUseBlocks.map((toolUse) => ({
            toolCallId: toolUse.id,
            name: toolUse.name,
            arguments: toolUse.inputJson,
            payload: toolUse,
          })),
        };
      },
      applyToolResults: (state, executions) => {
        const toolResults = executions.map((execution) => {
          const toolExecution = execution.result;
          if (toolExecution.aborted) throw createDesktopAbortError();
          return {
            type: 'tool_result',
            tool_use_id: execution.call.toolCallId,
            content: toolExecution.output,
          };
        });
        // 先配对所有 tool_use，再由 Pipeline 根据 terminal signal 决定是否停止。
        apiMessages.push({ role: 'user', content: toolResults });
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
