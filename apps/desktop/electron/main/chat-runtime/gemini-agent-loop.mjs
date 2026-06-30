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
}) {
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // apiMessages 已含 system，回合结束按当前真实消息算权威用量，与压缩触发同口径。
    getContextInfo: () => computeContextInfo({ messages: apiMessages, contextWindow, tools }),
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

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    // 方案 A（完整会话量口径）：压缩触发按「完整 apiMessages」判定，与进度条分子、
    // 回合结束权威快照（getContextInfo）同口径，避免回合结束后数值从 ~200k 跳到 ~100k。
    const compaction = await runCompactionCheck({
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
    });
    if (compaction.compacted) {
      apiMessages = compaction.messages;
    }

    // 发送副本：仅对「发出去的消息」做微压缩 + 清洗，不回写 apiMessages，
    // 使 apiMessages 始终保持完整会话量（与进度条分子/压缩触发器同口径）。
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
      signal,
      webContents,
      streamId,
    });
    // 不再用发送副本回写 apiMessages：assistant 回合与 tool 结果会在下方
    // 显式 push 回完整的 apiMessages，保持完整会话量口径。

    if (!providerResponse.ok) {
      const text = providerResponse.errorText || '';
      const promptTooLong = isPromptTooLongResponse(providerResponse.status, text);
      if (promptTooLong && !promptTooLongRetryUsed) {
        const emergencyCompaction = await runCompactionCheck({
          messages: apiMessages,
          systemPrompt,
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
        });
        if (emergencyCompaction.compacted) {
          apiMessages = emergencyCompaction.messages;
          promptTooLongRetryUsed = true;
          continue;
        }
      }
      if (promptTooLong) {
        loop.sendError(
          buildPromptTooLongRecoveryError({
            text,
            providerTracePath: providerResponse.providerTracePath,
            retryUsed: promptTooLongRetryUsed,
          }),
        );
        return;
      }
      if (providerResponse.providerError) {
        loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
        return;
      }
      loop.sendHttpError(providerResponse.status, text);
      return;
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
      if (terminalResponse.action === 'retry') continue;
      return;
    }

    apiMessages.push({
      role: 'assistant',
      content: content || null,
      geminiContent: {
        role: 'model',
        parts: [
          ...(content ? [{ text: content }] : []),
          ...toolCalls.map((tc) => ({
            functionCall: {
              name: tc.name,
              args: JSON.parse(tc.arguments || '{}'),
            },
          })),
        ],
      },
    });

    const functionResponses = [];
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
      functionResponses.push({
        functionResponse: {
          name: tc.name,
          response: { result: toolExecution.output },
        },
      });
      if (toolExecution.controlSignal?.terminal) terminalControlSignal = toolExecution.controlSignal;
    }

    apiMessages.push({
      role: 'tool',
      content: JSON.stringify(functionResponses),
      geminiContent: {
        role: 'user',
        parts: functionResponses,
      },
    });

    if (terminalControlSignal) {
      loop.sendDone();
      return;
    }
  }

  loop.sendLoopExhausted();
}
