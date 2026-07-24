export const AGENT_LOOP_UNBOUNDED = Number.POSITIVE_INFINITY;
export const DEFAULT_AGENT_LOOP_MAX_TURNS = AGENT_LOOP_UNBOUNDED;

import { createContextProjectionLifecycle } from '@peer-agent/runtime-core';
import { applyMicrocompaction } from './compaction-coordinator.mjs';

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
  // ADR 52：回合自然结束时，由各 loop 注入的闭包返回下一次最终请求投影
  // （{ nextRequestInputTokens, contextWindow, compactionSuggested }），随 done 事件下发。
  // renderer 与下一次 provider 请求前的 Runtime preflight 消费同一口径；返回 null 表示不附带。
  getContextInfo = null,
  // 21 号文档第十三章：per-turn 投影生命周期的稳定输入闭包。
  // 返回 { messages, tools, contextWindow }（messages 为当前 Runtime apiMessages）；
  // kernel 在稳定边界（tool_result / turn_complete）对其做 Layer 1 投影后发布快照。
  // 未提供时不创建生命周期（测试/旧调用方兼容）。
  getProjectionInput = null,
} = {}) {
  const normalizedMaxTurns = normalizeAgentLoopMaxTurns(maxTurns);
  // per-turn 投影生命周期：同一个 agent turn 内所有阶段（request_preflight /
  // post_compaction / tool_result / turn_complete）共用单调 revision，renderer 以
  // revision 序丢弃乱序快照，不再靠 Math.max 锁高位。发布失败不得影响主循环。
  const contextLifecycle = typeof getProjectionInput === 'function'
    ? createContextProjectionLifecycle((snapshot) => {
        try {
          webContents?.send?.('chat:context:projection', {
            streamId,
            conversationId,
            revision: snapshot.revision,
            phase: snapshot.projection.phase,
            nextRequestInputTokens: snapshot.projection.nextRequestInputTokens,
            previewInputTokens: snapshot.projection.previewInputTokens,
            compactionPressureTokens: snapshot.projection.compactionPressureTokens,
            contextWindow: snapshot.projection.contextWindow,
            percent: snapshot.projection.percent,
            pressure: snapshot.projection.pressure,
          });
        } catch {
          // 投影事件只服务展示，发送失败不影响 agent loop。
        }
      })
    : null;

  function stableProjectionInput() {
    if (typeof getProjectionInput !== 'function') return null;
    try {
      const input = getProjectionInput();
      if (!input || !Array.isArray(input.messages)) return null;
      // 与 computeContextInfo 同口径：稳定阶段先做 Layer 1 微压缩投影，
      // 保证生命周期快照与 done 快照 / preflight 预算的分子成分一致。
      return {
        messages: applyMicrocompaction(input.messages, { log: () => {} }).messages,
        tools: input.tools ?? null,
        contextWindow: input.contextWindow ?? null,
      };
    } catch {
      return null;
    }
  }

  function publishToolResultProjection() {
    if (!contextLifecycle) return;
    const input = stableProjectionInput();
    if (input) contextLifecycle.toolResult(input);
  }

  function publishTurnCompleteProjection() {
    if (!contextLifecycle) return;
    const input = stableProjectionInput();
    if (input) contextLifecycle.turnComplete(input);
  }

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
    // 回合自然结束：附带实际上下文用量与权威压力快照，供渲染端圆环对齐。
    // compactionSuggested 不授权 renderer 另起压缩任务；下一次 Runtime preflight 负责压缩并续跑。
    // 最后一轮 usage 快照只供诊断校准；闭包取数失败不得影响收尾。
    // 21 号文档第十三章：done 前先发布 turn_complete 稳定投影，替换流式预览。
    publishTurnCompleteProjection();
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
      // 只下发正数权威投影；0 表示缺失/空，交给 renderer 保留上一快照或本地历史。
      if (typeof contextInfo.nextRequestInputTokens === 'number'
        && Number.isFinite(contextInfo.nextRequestInputTokens)
        && contextInfo.nextRequestInputTokens > 0) {
        payload.nextRequestInputTokens = contextInfo.nextRequestInputTokens;
      }
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

  function getLastTurnUsage() {
    return lastTurnUsage;
  }

  function clearLastTurnUsage() {
    // 压缩成功后清掉陈旧 usage，避免下一轮 preflight 被压缩前的高水位反复强制触发。
    lastTurnUsage = null;
  }

  return {
    maxTurns: normalizedMaxTurns,
    usage,
    addUsage,
    getLastTurnUsage,
    clearLastTurnUsage,
    claimUnsupportedToolRetry,
    claimEmptyResponseRetry,
    claimThinkingOnlyRetry,
    sendDone,
    sendError,
    sendHttpError,
    sendLoopExhausted,
    // per-turn 投影生命周期：loop 把它传给 provider-request-coordinator，
    // 使 preflight / post_compaction 与 tool_result / turn_complete 共用同一 revision 序。
    contextLifecycle,
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
