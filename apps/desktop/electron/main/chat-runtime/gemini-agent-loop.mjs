import { sendGeminiStream } from '../provider-adapters/gemini-adapter.mjs';
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
  const loop = createAgentLoopKernel({ webContents, streamId, onRound: agentProgress?.onRound });
  const providerConfig = { provider: 'gemini', baseUrl: resolvedChannel?.baseUrl || baseUrl, apiKey, model, maxOutputTokens };

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
    const providerResponse = await sendGeminiStream({
      baseUrl,
      apiKey,
      endpoint: resolvedChannel?.endpoint,
      headers: resolvedChannel?.headers,
      model,
      messages: apiMessages,
      tools,
      effort,
      supportsReasoning: Boolean(resolvedChannel?.supportsReasoning ?? supportsReasoning),
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
