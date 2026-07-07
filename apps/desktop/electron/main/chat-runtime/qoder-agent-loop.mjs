import { sendQoderPrivateStream } from '../provider-adapters/qoder-private-adapter.mjs';
import { createAgentLoopKernel } from './agent-loop-kernel.mjs';
import { computeContextInfo } from './compaction-coordinator.mjs';
import { sanitizeApiMessages } from './message-sanitizer.mjs';

function makeAbortError() {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export async function agentLoopQoder({
  baseUrl,
  apiKey,
  model = 'Auto',
  systemPrompt,
  messages,
  webContents,
  streamId,
  signal,
  contextWindow,
  agentProgress = null,
  maxOutputTokens = 0,
  resolvedChannel = null,
}) {
  const apiMessages = sanitizeApiMessages([{ role: 'system', content: systemPrompt }, ...messages]);
  const loop = createAgentLoopKernel({
    webContents,
    streamId,
    onRound: agentProgress?.onRound,
    getContextInfo: () => computeContextInfo({
      messages: apiMessages,
      contextWindow,
      tools: [],
    }),
  });

  const providerResponse = await sendQoderPrivateStream({
    baseUrl,
    apiKey,
    endpoint: resolvedChannel?.endpoint,
    model,
    messages: apiMessages,
    maxOutputTokens,
    signal,
    webContents,
    streamId,
  });

  if (signal?.aborted) throw makeAbortError();
  loop.addUsage(providerResponse.streamUsage);
  if (!providerResponse.ok) {
    if (providerResponse.providerError) {
      loop.sendError(`${providerResponse.errorText || 'qoder_private_error'}${providerResponse.providerTracePath ? ` provider_trace=${providerResponse.providerTracePath}` : ''}`);
      return;
    }
    loop.sendHttpError(providerResponse.status, providerResponse.errorText || 'qoder_private_error');
    return;
  }

  const content = String(providerResponse.content || '').trim();
  if (!content) {
    loop.sendError('qoder_private_empty_response');
    return;
  }
  loop.sendDone();
}
