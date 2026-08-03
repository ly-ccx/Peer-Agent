import { sendAnthropicMessagesStream } from '../provider-adapters/anthropic-messages-adapter.mjs';
import { countAnthropicCanonicalRequest } from '../provider-adapters/context-count-adapter.mjs';
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
  rebuildSystemPrompt = null,
  toolContext,
  workspacePath,
  permissionGate,
  registry,
  runtimeProjection,
  mcpRegistry,
  goalPlanStore,
  ensureBrowserReady = null,
  onNativeReasoningFallback = null,
  resolvedChannel = null,
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
  let effectiveSystem = effectiveSystemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
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
    countCapability: { kind: 'provider_count_api' },
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
      initialize: () => ({ provider: 'anthropic' }),
      runTurn: async (state) => {
        const execution = await executeDesktopProviderRequest({
          request: {
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
            countCapability: { kind: 'provider_count_api' },
            countRequest: (canonicalRequest) => countAnthropicCanonicalRequest({
              baseUrl,
              apiKey,
              headers: resolvedChannel?.headers,
              ...canonicalRequest,
              supportsReasoning: effectiveSupportsReasoning,
              reasoningParamStyle: resolvedChannel?.reasoningParamStyle,
              reasoningEffortMap: resolvedChannel?.reasoningEffortMap,
              promptCaching:
                resolvedChannel?.supportsPromptCaching ?? supportsPromptCaching,
              maxOutputTokens,
              signal,
            }),
            onContextAccounting: loop.acceptContextAccounting,
          },
          buildCanonicalRequest: ({ messages: projectedMessages, systemPrompt: projectedSystem }) => ({
            model,
            system: projectedSystem,
            messages: sanitizeApiMessages(
              projectedMessages.filter((message) => message.role !== 'system'),
            ),
            tools,
            effort,
          }),
          send: (canonicalRequest) => sendAnthropicMessagesStream({
              baseUrl,
              apiKey,
              endpoint: resolvedChannel?.endpoint,
              headers: resolvedChannel?.headers,
              ...canonicalRequest,
              supportsReasoning: effectiveSupportsReasoning,
              reasoningParamStyle: resolvedChannel?.reasoningParamStyle,
              reasoningEffortMap: resolvedChannel?.reasoningEffortMap,
              promptCaching: resolvedChannel?.supportsPromptCaching ?? supportsPromptCaching,
              maxOutputTokens,
              signal,
              webContents: loop.providerWebContents,
              streamId,
            }),
        });
        if (typeof execution.systemPrompt === 'string' && execution.systemPrompt.trim()) {
          effectiveSystemPrompt = execution.systemPrompt;
        }
        effectiveSystem = execution.messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n\n') || effectiveSystemPrompt;
        apiMessages = execution.messages.filter((message) => message.role !== 'system');
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

        const {
          textContent,
          thinkingContent,
          thinkingSignature,
          toolUseBlocks,
          stopReason,
        } = providerResponse;
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
