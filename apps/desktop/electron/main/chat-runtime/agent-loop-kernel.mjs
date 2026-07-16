export const AGENT_LOOP_UNBOUNDED = Number.POSITIVE_INFINITY;
export const DEFAULT_AGENT_LOOP_MAX_TURNS = AGENT_LOOP_UNBOUNDED;

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
  maxTurns = defaultAgentLoopMaxTurns(),
  maxUnsupportedToolRetries = 1,
  maxEmptyResponseRetries = 1,
  maxThinkingOnlyRetries = 1,
  // provider 无关的「模型轮次」信号：每次 addUsage（每轮恰好一次）回调一次。
  // 用于 Goal Runner 展示用的实时轮次计数，与具体 provider 解耦。
  onRound = null,
  // 口径统一：回合自然结束时，由各 loop 注入的闭包返回「权威上下文用量」快照
  // （{ contextTokens, contextWindow, compactionSuggested }），随 done 事件下发。
  // renderer 只消费用量/压力投影；真正的自动压缩由下一次 provider 请求前的 Runtime
  // preflight 阻塞执行，不能从 done 旁路启动。返回 null 表示不附带。
  getContextInfo = null,
} = {}) {
  const normalizedMaxTurns = normalizeAgentLoopMaxTurns(maxTurns);
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };
  // 最后一轮 usage 快照（每轮覆盖，非累加）。显示口径需要「最后一轮请求实际发送的
  // input + cacheRead」来反映真实上下文大小；上面的 usage 是 lifetime 累加（计费 ledger），
  // 不能当上下文大小用。详见 ADR 42。null 表示尚无可用的 provider usage。
  let lastTurnUsage = null;
  let unsupportedToolRetries = 0;
  let emptyResponseRetries = 0;
  let thinkingOnlyRetries = 0;

  function addUsage(streamUsage = null) {
    // 每轮模型响应恰好调用一次 addUsage，故在此回调 onRound 作为「轮次」信号。
    // 放在 streamUsage 空判定之前，确保无计费 usage 的轮次也被计入。
    if (typeof onRound === 'function') {
      try {
        onRound();
      } catch {
        // 进度回调失败不得影响主循环。
      }
    }
    if (!streamUsage) return usage;
    usage.inputTokens += streamUsage.inputTokens || 0;
    usage.outputTokens += streamUsage.outputTokens || 0;
    usage.cacheWriteTokens += streamUsage.cacheWriteTokens || 0;
    usage.cacheReadTokens += streamUsage.cacheReadTokens || 0;
    // 记录本轮快照（覆盖式）：仅当本轮带到了真实 input/cacheRead 才更新，
    // 避免无计费 usage 的轮次把上一轮有效快照清掉。
    if ((streamUsage.inputTokens || 0) > 0 || (streamUsage.cacheReadTokens || 0) > 0) {
      lastTurnUsage = {
        inputTokens: streamUsage.inputTokens || 0,
        outputTokens: streamUsage.outputTokens || 0,
        cacheWriteTokens: streamUsage.cacheWriteTokens || 0,
        cacheReadTokens: streamUsage.cacheReadTokens || 0,
      };
    }
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

  function claimThinkingOnlyRetry() {
    if (thinkingOnlyRetries >= maxThinkingOnlyRetries) return false;
    thinkingOnlyRetries += 1;
    return true;
  }

  function sendDone() {
    // 回合自然结束：附带权威上下文用量与压力快照，供渲染端进度条对齐。
    // compactionSuggested 不授权 renderer 另起压缩任务；下一次 Runtime preflight 负责压缩并续跑。
    // 闭包取数失败不得影响收尾。
    // 口径分离（ADR 42）：把「最后一轮 usage 快照」传给 getContextInfo，使显示口径
    // 优先采用 provider 真实 input+cacheRead（压缩后回落），触发口径仍按完整会话量判定。
    let contextInfo = null;
    if (typeof getContextInfo === 'function') {
      try {
        contextInfo = getContextInfo({ usageSnapshot: lastTurnUsage });
      } catch {
        contextInfo = null;
      }
    }
    const payload = { streamId, usage };
    if (contextInfo && typeof contextInfo === 'object') {
      if (typeof contextInfo.contextTokens === 'number') payload.contextTokens = contextInfo.contextTokens;
      if (typeof contextInfo.contextWindow === 'number') payload.contextWindow = contextInfo.contextWindow;
      if (typeof contextInfo.compactionSuggested === 'boolean') {
        payload.compactionSuggested = contextInfo.compactionSuggested;
      }
    }
    webContents?.send?.('chat:stream:done', payload);
  }

  function sendError(error) {
    const payload = { streamId, error };
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
    usage,
    addUsage,
    claimUnsupportedToolRetry,
    claimEmptyResponseRetry,
    claimThinkingOnlyRetry,
    sendDone,
    sendError,
    sendHttpError,
    sendLoopExhausted,
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

  loop.sendDone();
  return { action: 'done' };
}
