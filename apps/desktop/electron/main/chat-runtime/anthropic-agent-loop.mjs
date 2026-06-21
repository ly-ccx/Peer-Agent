import { sendAnthropicMessagesStream } from '../provider-adapters/anthropic-messages-adapter.mjs';
import {
  createAgentLoopKernel,
  handleTerminalTextResponse,
} from './agent-loop-kernel.mjs';
import {
  applyMicrocompaction,
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
}) {
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  const loop = createAgentLoopKernel({ webContents, streamId });
  const providerConfig = { provider: 'anthropic', baseUrl: resolvedChannel?.baseUrl || baseUrl, apiKey, model };
  let effectiveSupportsReasoning = Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning);

  for (let turn = 0; turn < loop.maxTurns; turn++) {
    const microcompactResult = applyMicrocompaction(apiMessages);
    if (microcompactResult.stats.compactedCount > 0) {
      apiMessages = microcompactResult.messages;
    }

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
    });
    if (compaction.compacted) {
      effectiveSystem = compaction.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      apiMessages = compaction.messages.filter((m) => m.role !== 'system');
    }

    apiMessages = sanitizeApiMessages(apiMessages);
    const providerResponse = await sendAnthropicMessagesStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      headers: resolvedChannel?.headers,
      model,
      system: effectiveSystem,
      messages: apiMessages,
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
    apiMessages = providerResponse.messages;

    if (!providerResponse.ok) {
      const text = providerResponse.errorText || '';
      if (providerResponse.providerError) {
        loop.sendError(`${text}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
        return;
      }
      if (isPromptTooLongResponse(providerResponse.status, text)) {
        const emergencyCompaction = await runCompactionCheck({
          messages: [{ role: 'system', content: effectiveSystem }, ...apiMessages],
          systemPrompt: effectiveSystem,
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
          effectiveSystem = emergencyCompaction.messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n');
          apiMessages = emergencyCompaction.messages.filter((m) => m.role !== 'system');
          continue;
        }
      }
      loop.sendHttpError(providerResponse.status, text);
      return;
    }

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
    if (thinkingContent && thinkingSignature) {
      assistantContent.push({ type: 'thinking', thinking: thinkingContent, signature: thinkingSignature });
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
