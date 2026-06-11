export const DEFAULT_AGENT_LOOP_MAX_TURNS = 20;

function hasBillableUsage(usage) {
  return Boolean(
    (usage?.inputTokens || 0) ||
    (usage?.outputTokens || 0) ||
    (usage?.cacheWriteTokens || 0) ||
    (usage?.cacheReadTokens || 0)
  );
}

export function createAgentLoopKernel({
  webContents,
  streamId,
  maxTurns = DEFAULT_AGENT_LOOP_MAX_TURNS,
  maxUnsupportedToolRetries = 1,
  maxEmptyResponseRetries = 1,
} = {}) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  let unsupportedToolRetries = 0;
  let emptyResponseRetries = 0;

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

  function claimEmptyResponseRetry() {
    if (emptyResponseRetries >= maxEmptyResponseRetries) return false;
    emptyResponseRetries += 1;
    return true;
  }

  function sendDone() {
    webContents?.send?.('chat:stream:done', { streamId, usage });
  }

  function sendError(error) {
    const payload = { streamId, error };
    if (hasBillableUsage(usage)) payload.usage = usage;
    webContents?.send?.('chat:stream:error', payload);
  }

  function sendHttpError(status, text) {
    sendError(`HTTP ${status}: ${String(text || '').slice(0, 300)}`);
  }

  return {
    maxTurns,
    usage,
    addUsage,
    claimUnsupportedToolRetry,
    claimEmptyResponseRetry,
    sendDone,
    sendError,
    sendHttpError,
  };
}

function isToolResultMessage(message) {
  if (message?.role === 'tool') return true;
  return (
    message?.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block?.type === 'tool_result')
  );
}

function appendUserCorrection(apiMessages, content) {
  const last = apiMessages?.[apiMessages.length - 1];
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: content });
    return;
  }
  apiMessages.push({ role: 'user', content });
}

export function handleTerminalTextResponse({
  text,
  thinking = '',
  providerTracePath = null,
  apiMessages,
  loop,
  responseGuard,
} = {}) {
  const content = String(text || '');
  const thinkingContent = String(thinking || '');
  if (!content.trim()) {
    // 深度模式下模型可能只产出了 thinking 而正文为空。此时不是错误响应，
    // 已通过 chat:stream:thinking 推送给渲染层，正常结束即可。
    if (thinkingContent.trim()) {
      loop.sendDone();
      return { action: 'done', reason: 'thinking-only' };
    }
    if (
      Array.isArray(apiMessages) &&
      isToolResultMessage(apiMessages[apiMessages.length - 1]) &&
      loop.claimEmptyResponseRetry?.()
    ) {
      const correction = responseGuard.emptyModelResponseCorrection?.()
        || 'The previous model response was empty after tool results. Continue with text or a real tool call.';
      appendUserCorrection(apiMessages, correction);
      return { action: 'retry', reason: 'empty-response-after-tool-result' };
    }
    loop.sendError(responseGuard.emptyModelResponseError({ providerTracePath }));
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
