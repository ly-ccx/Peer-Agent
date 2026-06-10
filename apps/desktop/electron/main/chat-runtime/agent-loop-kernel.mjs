export const DEFAULT_AGENT_LOOP_MAX_TURNS = 20;

export function createAgentLoopKernel({
  webContents,
  streamId,
  maxTurns = DEFAULT_AGENT_LOOP_MAX_TURNS,
  maxUnsupportedToolRetries = 1,
} = {}) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  let unsupportedToolRetries = 0;

  function addUsage(streamUsage = null) {
    if (!streamUsage) return usage;
    usage.inputTokens += streamUsage.inputTokens || 0;
    usage.outputTokens += streamUsage.outputTokens || 0;
    usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
    usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    return usage;
  }

  function claimUnsupportedToolRetry() {
    if (unsupportedToolRetries >= maxUnsupportedToolRetries) return false;
    unsupportedToolRetries += 1;
    return true;
  }

  function sendDone() {
    webContents?.send?.('chat:stream:done', { streamId, usage });
  }

  function sendError(error) {
    webContents?.send?.('chat:stream:error', { streamId, error });
  }

  function sendHttpError(status, text) {
    sendError(`HTTP ${status}: ${String(text || '').slice(0, 300)}`);
  }

  return {
    maxTurns,
    usage,
    addUsage,
    claimUnsupportedToolRetry,
    sendDone,
    sendError,
    sendHttpError,
  };
}

export function handleTerminalTextResponse({
  text,
  apiMessages,
  loop,
  responseGuard,
} = {}) {
  const content = String(text || '');
  if (!content.trim()) {
    loop.sendError(responseGuard.emptyModelResponseError());
    return { action: 'stop', reason: 'empty-response' };
  }

  if (responseGuard.shouldRetryNoToolResponse(content)) {
    if (loop.claimUnsupportedToolRetry()) {
      apiMessages.push({
        role: 'user',
        content: responseGuard.unsupportedToolResponseCorrection(),
      });
      return { action: 'retry', reason: 'unsupported-tool-claim' };
    }
    loop.sendError(responseGuard.unsupportedToolResponseFallback());
    return { action: 'stop', reason: 'unsupported-tool-claim-exhausted' };
  }

  loop.sendDone();
  return { action: 'done' };
}
