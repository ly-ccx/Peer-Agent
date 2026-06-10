import { sendOpenAIChatStream } from '../provider-adapters/openai-chat-adapter.mjs';
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
  contextWindow,
  conversationId,
  persistCompaction,
  toolContext,
  workspacePath,
  permissionGate,
}) {
  let apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({ webContents, streamId });
  const providerConfig = { provider: 'openai', baseUrl, apiKey, model };

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
    });
    if (compaction.compacted) {
      apiMessages = compaction.messages;
    }

    apiMessages = sanitizeApiMessages(apiMessages);
    const providerResponse = await sendOpenAIChatStream({
      baseUrl,
      apiKey,
      model,
      messages: apiMessages,
      tools,
      effort,
      signal,
      webContents,
      streamId,
    });
    apiMessages = providerResponse.messages;

    if (!providerResponse.ok) {
      const text = providerResponse.errorText || '';
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
        });
        if (emergencyCompaction.compacted) {
          apiMessages = emergencyCompaction.messages;
          continue;
        }
      }
      loop.sendHttpError(providerResponse.status, text);
      return;
    }

    const { content, toolCalls, streamUsage } = providerResponse;
    loop.addUsage(streamUsage);

    if (!toolCalls.length) {
      const terminalResponse = handleTerminalTextResponse({
        text: content,
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

  loop.sendDone();
}
