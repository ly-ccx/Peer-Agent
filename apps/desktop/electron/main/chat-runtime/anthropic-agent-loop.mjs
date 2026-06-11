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
  contextWindow,
  conversationId,
  persistCompaction,
  continuityContext = [],
  toolContext,
  workspacePath,
  permissionGate,
  onNativeReasoningFallback = null,
}) {
  let effectiveSystem = systemPrompt;
  let apiMessages = sanitizeApiMessages(messages);
  const loop = createAgentLoopKernel({ webContents, streamId });
  const providerConfig = { provider: 'anthropic', baseUrl, apiKey, model };
  let effectiveSupportsReasoning = Boolean(supportsReasoning);

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
      model,
      system: effectiveSystem,
      messages: apiMessages,
      tools,
      effort,
      supportsReasoning: effectiveSupportsReasoning,
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
      });
      if (toolExecution.aborted) return;
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: toolExecution.output });
    }
    apiMessages.push({ role: 'user', content: toolResults });
  }

  loop.sendDone();
}
