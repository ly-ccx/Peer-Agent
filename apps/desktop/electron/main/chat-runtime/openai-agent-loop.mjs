import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
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
}) {
  // 按鉴权方式选择 OpenAI 协议族的传输 adapter,保持循环逻辑统一。
  const useResponses = resolvedChannel?.wire === 'openai-responses' || authMethod === 'oauth_chatgpt';
  const sendStream = useResponses
    ? (args) => sendOpenAIResponsesStream({ ...args, accountId, omitMaxOutputTokens: authMethod === 'oauth_chatgpt' })
    : sendOpenAIChatStream;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  // 最后一轮「实际发送切片」（微压缩+清洗后真正发给 provider 的消息，已含 system）。供
  // getContextInfo 显示口径在 provider usage 缺失时回退估算之用；不参与压缩触发判定。
  let lastSentMessages = null;
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // 口径分离（ADR 42）：触发口径仍按「完整会话 apiMessages」（已含 system）判定，保持压缩时机不变；
    // 显示口径优先采用 kernel 传入的 provider 真实 usage 快照（最后一轮 input+cacheRead，压缩后回落），
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

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    // 自动 preflight 压缩：触发判定按完整 apiMessages 估算；切分时保留最新真人 user turn，
    // 避免用户刚发送的原文被 compaction summary 代替。
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
      preserveLatestUserTurn: true,
    });
    if (compaction.compacted) {
      apiMessages = compaction.messages;
    }

    // 发送副本：仅对「发出去的消息」做微压缩 + 清洗，不回写 apiMessages，
    // 使 apiMessages 始终保持完整会话量（与进度条分子/压缩触发器同口径）。
    const sendMessages = sanitizeApiMessages(applyMicrocompaction(apiMessages).messages);
    // 记录本轮实际发送切片，供回合结束 getContextInfo 的显示口径在 provider usage 缺失时回退估算。
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
          preserveLatestUserTurn: true,
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
      if (
        effectiveSupportsReasoning &&
        (effort === 'high' || effort === 'xhigh') &&
        !String(content || '').trim() &&
        !String(thinkingContent || '').trim()
      ) {
        effectiveSupportsReasoning = false;
        onNativeReasoningFallback?.({ provider: 'openai', reason: 'empty_response' });
        continue;
      }
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
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

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
      // 必须为每个 tool_call 写回配对的 tool message，再决定是否终止，
      // 否则会留下未应答的 tool_call 导致下一轮 OpenAI 请求被拒。
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolExecution.output });
      if (toolExecution.controlSignal?.terminal) terminalControlSignal = toolExecution.controlSignal;
    }

    // 运行时护栏：当本回合调用了 request_user_input 这类「请求用户输入」能力时，
    // 停止回灌、把控制权交还用户，而不是自行继续决策。详见 request_user_input 设计。
    if (terminalControlSignal) {
      loop.sendDone();
      return;
    }
  }

  loop.sendLoopExhausted();
}
