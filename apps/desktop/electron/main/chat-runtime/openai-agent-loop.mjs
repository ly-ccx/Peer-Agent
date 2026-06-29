import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import {
  applyMicrocompaction,
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
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // apiMessages 已含 system，回合结束按当前真实消息算权威用量，与压缩触发同口径。
    getContextInfo: () => computeContextInfo({ messages: apiMessages, contextWindow }),
  });
  const providerConfig = { provider: 'openai', baseUrl: resolvedChannel?.baseUrl || baseUrl, apiKey, model, maxOutputTokens };
  let effectiveSupportsReasoning = Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning);

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    const microcompactResult = applyMicrocompaction(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
    }

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
    });
    if (compaction.compacted) {
      apiMessages = compaction.messages;
    }

    apiMessages = sanitizeApiMessages(apiMessages);
    const providerResponse = await sendStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      headers: resolvedChannel?.headers,
      model,
      messages: apiMessages,
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
    apiMessages = providerResponse.messages;

    if (!providerResponse.ok) {
      const text = providerResponse.errorText || '';
      if (providerResponse.providerError) {
        loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
        return;
      }
      if (isPromptTooLongResponse(providerResponse.status, text)) {
        const emergencyCompaction = await runCompactionCheck({
          messages: apiMessages,
          systemPrompt,
          contextWindow,
          providerConfig: null,
          signal,
          persistCompaction,
          conversationId,
          streamId,
          webContents,
          emergency: true,
          force: true,
          continuityContext,
        });
        if (emergencyCompaction.compacted) {
          apiMessages = emergencyCompaction.messages;
          continue;
        }
      }
      loop.sendHttpError(providerResponse.status, text);
      return;
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
