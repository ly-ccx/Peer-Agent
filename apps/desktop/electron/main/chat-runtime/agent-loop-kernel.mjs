export const AGENT_LOOP_UNBOUNDED = Number.POSITIVE_INFINITY;
export const DEFAULT_AGENT_LOOP_MAX_TURNS = AGENT_LOOP_UNBOUNDED;

import {
  createContextAccountingLifecycle,
  createRuntimeUsageAccounting,
  createUnknownContextAccountingSnapshot,
  isContextAccountingSnapshotCurrent,
} from '@peer-agent/runtime-core';

export function normalizeAgentLoopMaxTurns(value) {
  if (value === undefined || value === null || value === '' || value === false) {
    return AGENT_LOOP_UNBOUNDED;
  }
  if (value === AGENT_LOOP_UNBOUNDED || value === true) return AGENT_LOOP_UNBOUNDED;
  const text = String(value).trim().toLowerCase();
  if (
    !text ||
    text === '0' ||
    text === 'none' ||
    text === 'unbounded' ||
    text === 'unlimited' ||
    text === 'infinite' ||
    text === 'infinity'
  ) {
    return AGENT_LOOP_UNBOUNDED;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : AGENT_LOOP_UNBOUNDED;
}

function defaultAgentLoopMaxTurns() {
  return normalizeAgentLoopMaxTurns(process.env.PEER_AGENT_AGENT_LOOP_MAX_TURNS);
}

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
  conversationId = null,
  maxTurns = defaultAgentLoopMaxTurns(),
  maxUnsupportedToolRetries = 1,
  maxEmptyResponseRetries = 1,
  maxThinkingOnlyRetries = 1,
  // provider 无关的「模型轮次」信号：每次 addUsage（每轮恰好一次）回调一次。
  // 用于 Goal Runner 展示用的实时轮次计数，与具体 provider 解耦。
  onRound = null,
  emitRuntimeEvent = null,
  accountingIdentity = null,
  initialContextAccounting = null,
  contextWindow = null,
  countCapability = { kind: 'observed_usage_only' },
} = {}) {
  const normalizedMaxTurns = normalizeAgentLoopMaxTurns(maxTurns);
  const normalizedIdentity = {
    conversationId: String(
      accountingIdentity?.conversationId || conversationId || streamId || 'desktop',
    ),
    contentRevision: Number.isSafeInteger(accountingIdentity?.contentRevision)
      && accountingIdentity.contentRevision >= 0
      ? accountingIdentity.contentRevision
      : 0,
    modelKey: String(accountingIdentity?.modelKey || 'unknown-model'),
  };
  const initialSnapshot = isContextAccountingSnapshotCurrent(
    initialContextAccounting,
    normalizedIdentity,
  )
    ? initialContextAccounting
    : createUnknownContextAccountingSnapshot({
        identity: normalizedIdentity,
        contextWindow,
        countCapability,
        phase: 'request_preflight',
        pendingUncountedChanges: true,
      });
  const contextLifecycle = createContextAccountingLifecycle({
    initialSnapshot,
    onSnapshot(snapshot) {
      try {
        emitRuntimeEvent?.({
          type: 'context.accounting',
          sessionId: normalizedIdentity.conversationId,
          streamId,
          conversationId: normalizedIdentity.conversationId,
          snapshot,
        });
      } catch {
        // Accounting telemetry must not interrupt the provider loop.
      }
    },
  });

  function acceptContextAccounting(next) {
    return contextLifecycle.stable(next, next.phase);
  }

  function publishToolResultProjection() {
    contextLifecycle.markPending('tool_result');
  }

  const providerWebContents = {
    send(channel, payload) {
      if (
        (channel === 'chat:stream:delta' || channel === 'chat:stream:thinking')
        && typeof payload?.content === 'string'
        && payload.content
      ) {
        contextLifecycle.streamPreview(payload.content);
      }
      return webContents?.send?.(channel, payload);
    },
  };

  // One runtime turn may contain many provider requests. Keep their two
  // meanings explicit: lastRequest is context-capacity truth; turnTotal is the
  // billable aggregate persisted by the terminal path.
  const usageAccounting = createRuntimeUsageAccounting();
  let unsupportedToolRetries = 0;
  let emptyResponseRetries = 0;
  let thinkingOnlyRetries = 0;

  function addUsage(streamUsage = null, metadata = {}) {
    // 每轮模型响应恰好调用一次 addUsage，故在此回调 onRound 作为「轮次」信号。
    // 放在 streamUsage 空判定之前，确保无计费 usage 的轮次也被计入。
    if (typeof onRound === 'function') {
      try {
        onRound();
      } catch {
        // 进度回调失败不得影响主循环。
      }
    }
    return usageAccounting.observeProviderRequest(streamUsage, metadata).turnTotal;
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

  function claimThinkingOnlyRetry() {
    if (thinkingOnlyRetries >= maxThinkingOnlyRetries) return false;
    thinkingOnlyRetries += 1;
    return true;
  }

  function sendDone() {
    const usage = usageAccounting.snapshot().turnTotal;
    const payload = {
      streamId,
      usage,
      contextAccounting: contextLifecycle.current(),
    };
    webContents?.send?.('chat:stream:done', payload);
  }

  function sendError(error) {
    const usage = usageAccounting.snapshot().turnTotal;
    const payload = {
      streamId,
      error,
      contextAccounting: contextLifecycle.current(),
    };
    if (hasBillableUsage(usage)) payload.usage = usage;
    webContents?.send?.('chat:stream:error', payload);
  }

  function sendHttpError(status, text) {
    sendError(`HTTP ${status}: ${String(text || '').slice(0, 300)}`);
  }

  function sendLoopExhausted({ turns = normalizedMaxTurns } = {}) {
    const budget = Number.isFinite(turns) ? String(turns) : 'unbounded';
    sendError(
      `agent_loop_exhausted: configured agent loop turn budget (${budget}) was reached before the model returned a terminal response. The task is not complete; continue the conversation to resume.`
    );
  }

  return {
    maxTurns: normalizedMaxTurns,
    get usage() {
      return usageAccounting.snapshot().turnTotal;
    },
    usageAccounting,
    addUsage,
    claimUnsupportedToolRetry,
    claimEmptyResponseRetry,
    claimThinkingOnlyRetry,
    sendDone,
    sendError,
    sendHttpError,
    sendLoopExhausted,
    contextLifecycle,
    acceptContextAccounting,
    getContextAccounting: () => contextLifecycle.current(),
    providerWebContents,
    publishToolResultProjection,
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
    if (thinkingContent.trim()) {
      if (loop.claimThinkingOnlyRetry?.()) {
        const correction = responseGuard.thinkingOnlyResponseCorrection?.()
          || 'The previous response contained only hidden reasoning and no final answer or real tool call. Continue with a final answer or an actual tool call.';
        appendUserCorrection(apiMessages, correction);
        return { action: 'retry', reason: 'thinking-only-response' };
      }
      const error = typeof responseGuard.thinkingOnlyResponseError === 'function'
        ? responseGuard.thinkingOnlyResponseError({ providerTracePath })
        : `thinking_only_response: 模型只返回了思考内容，没有返回正文或可执行工具调用。${providerTracePath ? ` provider_trace=${providerTracePath}` : ''}`;
      loop.sendError(error);
      return { action: 'stop', reason: 'thinking-only-response-exhausted' };
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
    const error = typeof responseGuard.unsupportedToolResponseError === 'function'
      ? responseGuard.unsupportedToolResponseError({ providerTracePath })
      : `unsupported_tool_response: 模型输出了工具调用意图或工具协议文本，但没有产生可执行工具调用；已重试后仍失败。${providerTracePath ? ` provider_trace=${providerTracePath}` : ''}`;
    loop.sendError(error);
    return { action: 'stop', reason: 'unsupported-tool-claim-exhausted' };
  }

  // sendDone 会在这里读取 Runtime 当前消息投影来生成右下角占用快照。
  // 先把本轮最终回复纳入历史，确保「回复结束」与「下一次发送前」看到的是同一份上下文；
  // 否则 done 只能看到上一轮实际发送切片，下一次发送重建历史时才补上 assistant，口径会跳变。
  if (Array.isArray(apiMessages)) {
    apiMessages.push({ role: 'assistant', content });
  }
  loop.sendDone();
  return { action: 'done' };
}
