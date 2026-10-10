import { checkpointWithoutLocalImagePixels } from '@peer-agent/runtime-node';
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
  runDesktopRuntimePipeline, createNotExecutedToolCall,
} from './runtime-pipeline-adapter.mjs';
import {
  executeModelToolCall,
  safeParseJson,
} from './tool-orchestrator.mjs';
import { createAnthropicToolResultContent } from './visual-observation-projection.mjs';

export async function agentLoopAnthropic({
  baseUrl,
  apiKey,
  model,
  systemPrompt,
  stableSystemPrompt,
  messages,
  tools,
  webContents,
  streamId,
  signal,
  effort,
  supportsReasoning = false,
  supportsPromptCaching = true,
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
  onNativeReasoningFallback = null,
  resolvedChannel = null,
  // Goal Runner 进度 sink：{ onRound } 每轮模型响应回调一次，用于实时轮次计数。
  agentProgress = null,
  executionBudget = null,
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
  const saved = executionBudget?.providerCheckpoint;
  if (saved && (saved.provider !== 'anthropic' || saved.providerId !== providerId || saved.model !== model)) throw new Error('continuity_model_changed');
  if (saved && saved.provider === 'anthropic' && saved.providerId === providerId && saved.model === model && Array.isArray(saved.messages)) {
    apiMessages = structuredClone(saved.messages);
  }
  const loop = createAgentLoopKernel({
    executionBudget,
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
    maxToolCalls: executionBudget?.maxToolCalls,
    sliceToolCalls: executionBudget?.sliceToolCalls,
    yieldAtTurnLimit: executionBudget?.yieldAtTurnLimit,
    maxToolBatchCalls: executionBudget?.maxToolBatchCalls,
    budgetGuard: executionBudget?.guard,
    signal,
    emitRuntimeEvent,
    eventState: runtimeEventState,
    lifecycle: {
      toolResultsApplied: () => loop.publishToolResultProjection(),
    },
    model: {
      checkpoint: (_state, executions) => executionBudget?.guard?.checkpoint?.({ provider: 'anthropic', providerId, model, messages: checkpointWithoutLocalImagePixels(apiMessages) }, executions),
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
            visualRequestHost: { goalPlanStore, workspacePath },
            runtimeUsageAccounting: loop.usageAccounting,
            budgetGuard: executionBudget?.guard,
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
            stableSystem: stableSystemPrompt,
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
            loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`, providerResponse.providerRecovery);
          } else {
            loop.sendHttpError(providerResponse.status, text, providerResponse.providerRecovery);
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
        // Compatible providers may return thinking without a signature.
        // Replay received reasoning before tool_use; never invent a signature.
        if (thinkingContent || thinkingSignature) {
          assistantContent.push({
            type: 'thinking',
            thinking: thinkingContent || '',
            ...(thinkingSignature ? { signature: thinkingSignature } : {}),
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
            content: createAnthropicToolResultContent(toolExecution),
          };
        });
        // 先配对所有 tool_use，再由 Pipeline 根据 terminal signal 决定是否停止。
        apiMessages.push({ role: 'user', content: toolResults });
        return state;
      },
      onYield: (_state, context) => {
        executionBudget?.onYield?.({ provider: 'anthropic', providerId, model, messages: checkpointWithoutLocalImagePixels(apiMessages),
          turns: context.turn, usage: loop.usage });
        loop.sendDone();
      },
      onStopped: (_state, executions) => {
        const reason = executions.find(item => item.terminal)?.terminalReason || '';
        if (/^(work_budget_limited|work_execution_stopped|.*outcome_unknown|batch_stopped|max_tool_calls_exceeded)$/.test(reason)) loop.sendError(reason);
        else loop.sendDone();
      },
      onExhausted: (_state, _context, reason) => loop.sendLoopExhausted({ reason }),
    },
    tools: {
      notExecuted: (call, reason) => createNotExecutedToolCall({ call, reason, webContents, streamId }),
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
