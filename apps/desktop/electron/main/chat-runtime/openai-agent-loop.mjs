import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
import { sendOpenAIResponsesStream } from '../provider-adapters/openai-responses-adapter.mjs';
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
  contextWindow,
  conversationId,
  persistCompaction,
  continuityContext = [],
  toolContext,
  workspacePath,
  permissionGate,
  onNativeReasoningFallback = null,
  // ADR 28: ChatGPT 订阅链路走 Responses 传输,需附带 accountId。
  authMethod = 'api_key',
  accountId = null,
}) {
  // 按鉴权方式选择 OpenAI 协议族的传输 adapter,保持循环逻辑统一。
  const useResponses = authMethod === 'oauth_chatgpt';
  const sendStream = useResponses
    ? (args) => sendOpenAIResponsesStream({ ...args, accountId })
    : sendOpenAIChatStream;
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({ webContents, streamId });
  const providerConfig = { provider: 'openai', baseUrl, apiKey, model };
  let effectiveSupportsReasoning = Boolean(supportsReasoning);

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
      model,
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
        effort === 'high' &&
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
      });
      if (toolExecution.aborted) return;
      apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: toolExecution.output });
    }
  }

  loop.sendLoopExhausted();
}
