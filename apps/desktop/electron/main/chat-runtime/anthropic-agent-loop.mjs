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
}) {
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    // 回合结束时按「当前真实 apiMessages + system」算权威用量，与压缩触发同口径。
    getContextInfo: () => computeContextInfo({
      messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
      contextWindow,
      tools,
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

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    // 方案 A（完整会话量口径）：压缩触发按「完整 apiMessages」判定，与进度条分子、
    // 回合结束权威快照（getContextInfo）同口径，避免回合结束后数值从 ~200k 跳到 ~100k。
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
    });
    if (compaction.compacted) {
      effectiveSystem = compaction.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      apiMessages = compaction.messages.filter((m) => m.role !== 'system');
    }

    // 发送副本：仅对「发出去的消息」做微压缩 + 清洗，不回写 apiMessages，
    // 使 apiMessages 始终保持完整会话量（与进度条分子/压缩触发器同口径）。
    const sendMessages = sanitizeApiMessages(applyMicrocompaction(apiMessages).messages);
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
    // 不再用发送副本回写 apiMessages：assistant 回合与 tool_result 会在下方
    // 显式 push 回完整的 apiMessages，保持完整会话量口径。

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
        });
        if (emergencyCompaction.compacted) {
          effectiveSystem = emergencyCompaction.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
          apiMessages = emergencyCompaction.messages.filter((m) => m.role !== 'system');
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

    const { textContent, thinkingContent, thinkingSignature, toolUseBlocks, stopReason, streamUsage } = providerResponse;
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
        continue;
      }
      const terminalResponse = handleTerminalTextResponse({
        text: textContent,
        // 深度模式下正文可能为空但已产出 thinking；把 thinking 计入“非空”，
        // 避免误报 empty_model_response。
        thinking: thinkingContent,
        providerTracePath: providerResponse.providerTracePath,
        apiMessages,
        loop,
        responseGuard,
      });
      if (terminalResponse.action === 'retry') continue;
      return;
    }

    const assistantContent = [];
    // Anthropic 要求多轮回传时 thinking block 在 content 数组最前，且带 signature。
    // 判定以 signature 为准而非 thinkingContent: 新代际(如 Opus 4.8)默认 display:"omitted"，
    // 返回的 thinking 字段恒为空但 signature 携带加密思维，服务端靠 signature 解密重建。
    // 若按 thinkingContent 判定会漏发 thinking block，违反工具多轮的强制回传要求，
    // 并触发 mid-turn thinking 冲突(thinking 被静默禁用 + prompt cache 失效)。
    if (thinkingSignature) {
      assistantContent.push({ type: 'thinking', thinking: thinkingContent || '', signature: thinkingSignature });
    }
    if (textContent) assistantContent.push({ type: 'text', text: textContent });
    for (const tu of effectiveToolUseBlocks) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: safeParseJson(tu.inputJson) });
    }
    apiMessages.push({ role: 'assistant', content: assistantContent });

    const toolResults = [];
    let terminalControlSignal = null;
    for (const tu of effectiveToolUseBlocks) {
      const toolExecution = await executeModelToolCall({
        name: tu.name,
        rawArguments: tu.inputJson,
        toolCallId: tu.id,
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
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: toolExecution.output });
      if (toolExecution.controlSignal?.terminal) terminalControlSignal = toolExecution.controlSignal;
    }
    // 必须先把所有 tool_use 配对的 tool_result 落回历史，再决定是否终止，
    // 否则会留下悬空 tool_use 导致下一轮 Anthropic 请求被拒。
    apiMessages.push({ role: 'user', content: toolResults });

    // 运行时护栏：当本回合调用了 request_user_input 这类「请求用户输入」能力时，
    // 停止回灌、把控制权交还用户，而不是自行继续决策。详见 request_user_input 设计。
    if (terminalControlSignal) {
      loop.sendDone();
      return;
    }
  }

  loop.sendLoopExhausted();
}
