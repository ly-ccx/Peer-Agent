/**
 * Context Compactor — 对标 Claude Code 的三层压缩体系
 *
 * Layer 1: 每轮 token 检查 (compactIfNeeded)
 * Layer 2: LLM 语义压缩 (summarizeWithLLM) → 结构摘要 fallback → 直接丢弃
 * Layer 3: 手动 /compact 指令（通过 chat:compact IPC handler）
 */

import {
  COMPACTION_PROGRESS_CONFIG,
  COMPACTION_SUMMARY_PROMPT as COMPACT_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT as SUMMARY_SYSTEM_PROMPT,
  CONTEXT_PROJECTION_CONFIG,
  estimateContextMessagesTokens,
  estimateContextTextTokens,
  estimateContextToolsTokens,
  estimateSummaryChars as estimateSummaryCharsCore,
  extractRecoverableClues,
  formatCompactionMessagesForSummary,
  microcompactMessagesForContext,
  previewHistoricalText,
  runCompactionSummaryCascade,
  selectGoalKeepMessages,
  splitMessagesForCompaction,
} from '@peer-agent/runtime-core';
import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';
import { buildCompactionMarker } from '@peer-agent/protocol';
import { encodeOpenAIResponsesRequest } from './provider-encoders/responses-encoder.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { logCompactionDiagnostic } from './compaction-diagnostic-log.mjs';
import { neutralizeToolCallSyntax } from './chat-runtime/message-sanitizer.mjs';

const COMPACTION_CONFIG = {
  // Token 投影与自动压缩阈值只有 runtime-core 一份真值；Desktop 这里只追加摘要执行参数。
  ...CONTEXT_PROJECTION_CONFIG,
  // 摘要输出上限不再写死：在 summarizeWithLLM 内复用当前模型的 maxOutputTokens，
  // 未配置时回退到 12000，避免长摘要被小上限截断（压缩后内容看不全）。
  // 摘要输入不设静态上限；仅受当前模型上下文窗口、输出预算与安全区约束。
  // 自动预检原样保留最近完整轮次；当前轮包含在内，工具调用与结果随轮次成对保留。
  preserveRecentTurns: 4,
  summaryTemperature: 0.2,
  maxPtlRetries: 3,
  circuitBreakerThreshold: 3,
  // 进度估算真值在 runtime-core/compaction-progress；Desktop 只 re-export 兼容字段。
  summaryCompressionRatio: COMPACTION_PROGRESS_CONFIG.summaryCompressionRatio,
  minEstimatedSummaryChars: COMPACTION_PROGRESS_CONFIG.minEstimatedSummaryChars,
  // 摘要生成默认输出预算；provider 未配置 maxOutputTokens 时回退到此值。
  defaultSummaryMaxTokens: 12_000,
  // 自动压缩触发时预留给「摘要输出」的 token，避免窗口顶满后摘要请求自身失败。
  summaryOutputReserveTokens: 4_000,
  // 额外安全区：provider framing / 工具 schema 抖动 / 估算误差。
  safetyReserveTokens: 1_000,
  // Legacy fallback only. Normal compaction uses planHandoffBudget() so semantic detail can grow
  // beyond 12k when the final request and provider output capacity have room.
  legacyCarryForwardFallbackTokens: 12_000,
  // Reserve enough room for several ordinary turns so compaction does not immediately retrigger.
  futureTurnReserveRatio: 0.08,
  minFutureTurnReserveTokens: 8_000,
  maxFutureTurnReserveTokens: 32_000,
  providerEnvelopeReserveTokens: 1_000,
  // Canonical checkpoint must carry actual continuity, not merely a marker envelope.
  // This is a semantic floor (roughly one short paragraph), not a normal-path ceiling.
  minCanonicalNarrativeChars: 32,
  // 现场证据：本地投影 461k，而 Grok provider 实际计为 928k（约 2.01x）。
  // 在没有 provider 原生 tokenizer 的前提下，只允许摘要输入使用可用窗口的 45%，
  // 即使 token 密度接近该现场样本，仍保留约 10% 的请求 framing 余量。
  summaryInputSafetyRatio: 0.45,
};

// ── Circuit breaker state (per-conversation scope) ──
// 历史上是 module 级全局计数,会跨会话串状态(A 会话连续失败会熔断 B 会话的压缩)。
// 现按 conversationId(缺省回退 streamId / 全局桶)隔离,见 23 号治理文档不变式 6。

const compactionFailuresByScope = new Map();

function breakerScopeKey(scope) {
  return typeof scope === 'string' && scope ? scope : '__global__';
}

export function resetCircuitBreaker(scope = null) {
  if (scope == null) {
    compactionFailuresByScope.clear();
    return;
  }
  compactionFailuresByScope.delete(breakerScopeKey(scope));
}

function isCircuitBreakerTripped(scope) {
  return (compactionFailuresByScope.get(breakerScopeKey(scope)) ?? 0)
    >= COMPACTION_CONFIG.circuitBreakerThreshold;
}

function recordCompactionSuccess(scope) {
  compactionFailuresByScope.delete(breakerScopeKey(scope));
}

function recordCompactionFailure(scope) {
  const key = breakerScopeKey(scope);
  const failures = (compactionFailuresByScope.get(key) ?? 0) + 1;
  compactionFailuresByScope.set(key, failures);
  if (failures >= COMPACTION_CONFIG.circuitBreakerThreshold) {
    console.warn(
      `[context-compactor] Circuit breaker tripped for scope=${key} after ${failures} consecutive failures — skipping future compaction attempts for this conversation`,
    );
  }
}

// ── Token Estimation （对标 CC roughTokenCountEstimationForMessages）──

// Compatibility exports for existing Desktop callers. The implementation and constants live in
// runtime-core so Desktop and CLI/TUI cannot drift in token projection or compaction pressure.
const estimateTextTokens = estimateContextTextTokens;
const estimateTokensFromMessages = estimateContextMessagesTokens;
const estimateToolsTokens = estimateContextToolsTokens;

function estimateFinalRequestBudget(messages, tools) {
  const messageTokens = estimateTokensFromMessages(messages);
  const toolTokens = estimateToolsTokens(tools);
  return {
    messageTokens,
    toolTokens,
    finalRequestTokens: messageTokens + toolTokens,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function planHandoffBudget({
  contextWindow,
  providerMaxOutputTokens,
  systemTokens = 0,
  toolSchemaTokens = 0,
  mandatoryKeepTokens = 0,
}) {
  const windowTokens = Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.floor(contextWindow)
    : null;
  const providerOutputLimit = Number.isFinite(providerMaxOutputTokens) && providerMaxOutputTokens > 0
    ? Math.floor(providerMaxOutputTokens)
    : COMPACTION_CONFIG.defaultSummaryMaxTokens;
  if (!windowTokens) {
    return {
      requestTargetTokens: null,
      handoffMaxTokens: providerOutputLimit,
      futureTurnReserveTokens: 0,
      providerOutputLimit,
      accountingSource: 'provider_output_only',
    };
  }

  const triggerLimit = Math.floor(windowTokens * COMPACTION_CONFIG.triggerRatio);
  // Every reserve scales down for small windows; absolute production defaults must never
  // collapse the usable request target or handoff budget to one token.
  const safetyReserveTokens = Math.min(
    COMPACTION_CONFIG.safetyReserveTokens,
    Math.max(0, Math.floor(triggerLimit * 0.1)),
  );
  const providerEnvelopeReserveTokens = Math.min(
    COMPACTION_CONFIG.providerEnvelopeReserveTokens,
    Math.max(0, Math.floor(triggerLimit * 0.05)),
  );
  const proportionalReserve = Math.floor(windowTokens * COMPACTION_CONFIG.futureTurnReserveRatio);
  const maxReserveForWindow = Math.max(
    0,
    Math.floor(triggerLimit * 0.25) - safetyReserveTokens,
  );
  const futureTurnReserveTokens = clamp(
    proportionalReserve,
    Math.min(COMPACTION_CONFIG.minFutureTurnReserveTokens, maxReserveForWindow),
    Math.min(COMPACTION_CONFIG.maxFutureTurnReserveTokens, maxReserveForWindow),
  );
  const requestTargetTokens = Math.max(
    1,
    triggerLimit - futureTurnReserveTokens - safetyReserveTokens,
  );
  const availableForHandoff = Math.max(
    1,
    requestTargetTokens
      - Math.max(0, systemTokens)
      - Math.max(0, toolSchemaTokens)
      - Math.max(0, mandatoryKeepTokens)
      - providerEnvelopeReserveTokens,
  );
  return {
    requestTargetTokens,
    handoffMaxTokens: Math.max(1, Math.min(providerOutputLimit, availableForHandoff)),
    futureTurnReserveTokens,
    safetyReserveTokens,
    providerEnvelopeReserveTokens,
    providerOutputLimit,
    availableForHandoff,
    accountingSource: 'dynamic_final_request_budget',
  };
}

function getLatestContinuitySummary(continuityContext) {
  const items = normalizeContinuityContext(continuityContext);
  return items.length > 0 ? items[items.length - 1].summary : '';
}

function buildCompactionDiagnosticContext({
  conversationId,
  continuityContext,
  deltaInputMessages,
  deltaSummary,
  resultMessages,
  tools,
}) {
  const previousSummary = getLatestContinuitySummary(continuityContext);
  const marker = resultMessages?.find((message) => message?._compaction)?._compaction ?? null;
  const finalBudget = estimateFinalRequestBudget(resultMessages ?? [], tools);
  return {
    conversationId: conversationId ?? null,
    accountingSource: 'runtime_estimate',
    previousSummaryTokens: estimateTextTokens(previousSummary),
    deltaInputTokens: estimateTokensFromMessages(deltaInputMessages ?? []),
    deltaSummaryTokens: estimateTextTokens(deltaSummary ?? ''),
    finalHandoffTokens: estimateTextTokens(marker?.summary ?? ''),
    keptMessageTokens: estimateTokensFromMessages(
      (resultMessages ?? []).filter((message) => message?.role !== 'system' && !message?._compaction),
    ),
    toolSchemaTokens: finalBudget.toolTokens,
    finalRequestTokens: finalBudget.finalRequestTokens,
  };
}

// ── Message Grouping（对标 CC groupMessagesByApiRound）──

function groupMessagesByApiRound(messages) {
  const groups = [];
  let current = [];
  let lastAssistantIdx = -1;

  for (const m of messages) {
    if (m.role === 'assistant') {
      if (lastAssistantIdx >= 0 && current.length > 0) {
        groups.push(current);
        current = [];
      }
      lastAssistantIdx = groups.length;
    }
    current.push(m);
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

// ── Threshold Checks ──

function shouldCompact(estimatedTokens, contextWindow) {
  if (!contextWindow) return false; // 用户未配置上下文窗口时不触发压缩
  return estimatedTokens > contextWindow * COMPACTION_CONFIG.triggerRatio;
}

function shouldRunCompaction({ force, estimatedTokens, contextWindow, messages }) {
  if (force) {
    // 真·全量压缩（见 真·全量压缩设计）：只要存在非 system 消息即值得压缩，
    // 全部进 old 摘要、keep 为空。避免空对话上强行压缩。
    const convMsgs = messages.filter((m) => m.role !== 'system');
    return convMsgs.length > 0;
  }
  return shouldCompact(estimatedTokens, contextWindow);
}

// ── Split ──

function messageHasToolResult(message) {
  if (message?.role === 'tool') return true;
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_result');
}

function messageHasToolUse(message) {
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) return true;
  return Array.isArray(message?.content) && message.content.some((block) => block?.type === 'tool_use');
}

function toolUseEntries(message, messageIndex) {
  const entries = [];
  if (Array.isArray(message?.tool_calls)) {
    message.tool_calls.forEach((toolCall, index) => {
      entries.push({ id: toolCall?.id || `unmatched-openai:${messageIndex}:${index}`, messageIndex });
    });
  }
  if (Array.isArray(message?.content)) {
    message.content.forEach((block, index) => {
      if (block?.type !== 'tool_use') return;
      entries.push({ id: block.id || `unmatched-anthropic:${messageIndex}:${index}`, messageIndex });
    });
  }
  return entries;
}

function toolResultIds(message) {
  const ids = [];
  if (message?.role === 'tool' && message.tool_call_id) ids.push(message.tool_call_id);
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id);
    }
  }
  return ids;
}

// 找到最新真人 user 之后仍未闭合的最早 tool_use。已经拿到全部 tool_result 的轮次
// 是可摘要的历史进展，不应因为仍处于同一个 Goal turn 就永久占据活跃上下文。
function findUnclosedToolTailStart(messages) {
  const pendingToolUses = new Map();
  messages.forEach((message, messageIndex) => {
    for (const entry of toolUseEntries(message, messageIndex)) {
      pendingToolUses.set(entry.id, entry.messageIndex);
    }
    for (const resultId of toolResultIds(message)) pendingToolUses.delete(resultId);
  });
  if (pendingToolUses.size === 0) return messages.length;
  return Math.min(...pendingToolUses.values());
}

function isHumanUserMessage(message) {
  if (message?.role !== 'user') return false;
  if (message?._compaction) return false;
  if (!Array.isArray(message.content)) return true;
  return message.content.some((block) => block?.type !== 'tool_result');
}

function expandKeepForToolContinuity({ keep, old }) {
  const expandedKeep = [...keep];
  const expandedOld = [...old];

  while (expandedKeep.length > 0 && messageHasToolResult(expandedKeep[0]) && expandedOld.length > 0) {
    const previous = expandedOld.pop();
    expandedKeep.unshift(previous);
    if (messageHasToolUse(previous)) break;
  }

  return { keep: expandedKeep, old: expandedOld };
}

// 定位「当前用户轮」起点：最后一个真人 user 消息的下标。
// Anthropic 工具结果在 provider 历史里也是 role=user + tool_result blocks；它不是用户输入，
// 不能被当成“最新用户原文”保留，否则会留下孤立 tool_result。
// 返回 -1 表示无真人 user 消息（异常路径，由调用方回退处理）。
function findCurrentTurnStart(convMsgs) {
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    if (isHumanUserMessage(convMsgs[i])) return i;
  }
  return -1;
}

function splitForCompaction(
  messages,
  {
    preserveLatestUserTurn = false,
    preserveRecentTurns = COMPACTION_CONFIG.preserveRecentTurns,
    goalKeepPolicy = null,
    contextWindow = null,
    recoveryLevel = 0,
  } = {},
) {
  // Goal 模式：有界 keep（turn/message/token 三重上限），不无限保留当前工具尾。
  if (goalKeepPolicy) {
    const selected = selectGoalKeepMessages(messages, {
      contextWindow,
      recoveryLevel,
      config: goalKeepPolicy === true ? undefined : goalKeepPolicy,
    });
    return {
      keep: [...selected.keepMessages],
      old: [...selected.oldMessages],
      systemMsgs: [...selected.systemMessages],
      goalKeep: {
        keepBudgetTokens: selected.keepBudgetTokens,
        keepTokens: selected.keepTokens,
        recoveryLevel: selected.recoveryLevel,
        degraded: selected.degraded,
        reason: selected.reason,
      },
    };
  }

  const split = splitMessagesForCompaction(messages, {
    preserveLatestUserTurn,
    // 自动 preflight 的契约是只保护当前真人用户轮次；手动/空闲压缩才保留配置的最近多轮。
    preserveRecentTurns: preserveLatestUserTurn ? 1 : preserveRecentTurns,
  });
  return {
    keep: [...split.keepMessages],
    old: [...split.oldMessages],
    systemMsgs: [...split.systemMessages],
    goalKeep: null,
  };
}

// ── Format Old Messages for LLM Summary ──

function formatOldMessagesForSummary(messages) {
  // 统一走 runtime-core 的摘要投影 seam：工具参数/结果、thinking 与未知块均有独立上限，
  // 避免 desktop 再次把完整 JSON 无界序列化进摘要请求。
  return formatCompactionMessagesForSummary(messages);
}

// ── formatCompactSummary（对标 CC formatCompactSummary）──

function formatCompactSummary(summary) {
  let formatted = neutralizeToolCallSyntax(summary);

  // Strip <analysis>...</analysis> — drafting scratchpad
  formatted = formatted.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');

  // Extract and format <summary> section
  const summaryMatch = formatted.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (summaryMatch) {
    const content = (summaryMatch[1] || '').trim();
    formatted = formatted.replace(
      /<summary>[\s\S]*?<\/summary>/i,
      `Summary:\n${content}`,
    );
  }

  // Clean up extra whitespace（3 个及以上连续换行压成 2 个；\u000a 即 LF）
  formatted = formatted.replace(/\u000a{3,}/g, '\u000a\u000a');

  return formatted.trim();
}

// ── LLM Semantic Summary（核心改进）──

// 逐行读取一个 SSE（text/event-stream）响应体，对每个 `data:` 负载调用 onData。
// 用于压缩的流式 LLM 调用：边读边累加字符，供 onProgress 估算真实进度。
async function readSseStream(res, onData) {
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    // 运行环境不支持流式读取（理论上不会发生在 Electron main 的 undici fetch）。
    const text = await res.text().catch(() => '');
    throw new Error(`summary stream unsupported (no readable body); fallback. raw=${text.slice(0, 120)}`);
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let totalChars = 0;
  let chunkCount = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      totalChars += chunk.length;
      chunkCount += 1;
      buffer += chunk;
      let nlIndex;
      while ((nlIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIndex).trim();
        buffer = buffer.slice(nlIndex + 1);
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        onData(payload);
      }
    }
  } catch (err) {
    // 读流循环中断（如 ECONNRESET）：记录已累计字符数与原始错误后 re-throw，
    // 不改变控制流（仍交由上层 fallback 处理），但让根因可见。
    logCompactionDiagnostic('readstream:error', {
      totalChars,
      chunkCount,
      errorName: err?.name ?? null,
      errorMessage: err?.message ?? String(err),
      errorCode: err?.code ?? err?.cause?.code ?? null,
      errorCause: err?.cause?.message ?? null,
    });
    throw err;
  }
}

/**
 * Desktop wrapper around runtime-core estimateSummaryChars (single progress source).
 * Kept as a local export so existing Desktop tests/call sites stay stable.
 */
function estimateSummaryChars({ inputChars, maxSummaryChars, receivedChars = 0 }) {
  return estimateSummaryCharsCore({ inputChars, maxSummaryChars, receivedChars });
}

/**
 * 为摘要生成解析输出/输入预算。
 * - 输出：复用模型 maxOutputTokens，并夹在安全范围内
 * - 输入：不设产品级静态上限；模型窗口可知时仅扣除输出与 safety，未知时不截断
 */
function resolveSummaryTokenBudget(providerConfig = {}, { contextWindow = null } = {}) {
  const configuredOutput = Number(providerConfig?.maxOutputTokens);
  const defaultOutput = COMPACTION_CONFIG.defaultSummaryMaxTokens;
  const summaryMaxTokens = Math.max(
    1_024,
    Math.min(
      Number.isFinite(configuredOutput) && configuredOutput > 0 ? configuredOutput : defaultOutput,
      defaultOutput * 2,
    ),
  );

  const safety = COMPACTION_CONFIG.safetyReserveTokens;
  const outputReserve = Math.max(
    COMPACTION_CONFIG.summaryOutputReserveTokens,
    Math.min(summaryMaxTokens, COMPACTION_CONFIG.summaryOutputReserveTokens * 2),
  );

  const windowTokens = Number(contextWindow);
  // 不再把摘要输入截在固定的 80k；能送多少由当前模型窗口决定。
  // 窗口未知时返回 Infinity，调用侧会直接使用完整旧消息。
  const availableInputTokens =
    Number.isFinite(windowTokens) && windowTokens > 0
      ? Math.max(2_000, windowTokens - summaryMaxTokens - safety)
      : Number.POSITIVE_INFINITY;
  const summaryMaxInputTokens = Number.isFinite(availableInputTokens)
    ? Math.max(2_000, Math.floor(availableInputTokens * COMPACTION_CONFIG.summaryInputSafetyRatio))
    : Number.POSITIVE_INFINITY;

  return {
    summaryMaxTokens,
    summaryMaxInputTokens,
    outputReserveTokens: outputReserve,
    safetyReserveTokens: safety,
  };
}

async function summarizeWithLLM({
  oldMessages,
  providerConfig,
  signal,
  onProgress,
  webContents = null,
  streamId = null,
  connectionRecoveryOptions = {},
  contextWindow = null,
  summaryInputTokenBudget = null,
  onProviderUsage = null,
  conversationId = null,
}) {
  const { provider, baseUrl, apiKey, model } = providerConfig;

  // 摘要输出/输入预算：输出对齐模型能力，输入为输出与安全区预留空间。
  const summaryBudget = resolveSummaryTokenBudget(providerConfig, { contextWindow });
  const summaryMaxTokens = summaryBudget.summaryMaxTokens;

  logCompactionDiagnostic('summarize:enter', {
    conversationId,
    providerConfig,
    summaryMaxTokens,
    oldMessageCount: Array.isArray(oldMessages) ? oldMessages.length : null,
  });

  const summaryInput = formatOldMessagesForSummary(oldMessages);
  const effectiveSummaryInputTokenBudget = Number.isFinite(Number(summaryInputTokenBudget))
    ? Math.max(256, Math.min(summaryBudget.summaryMaxInputTokens, Math.floor(Number(summaryInputTokenBudget))))
    : summaryBudget.summaryMaxInputTokens;
  const boundedSummaryInput = truncateSummaryInputToTokenBudget(
    summaryInput,
    effectiveSummaryInputTokenBudget,
  );
  const summaryMessages = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: boundedSummaryInput },
    { role: 'user', content: COMPACT_PROMPT },
  ];

  // 进度百分比分母：用「对实际摘要产出长度的估计」而非「模型最大输出容量」，
  // 避免进度收尾约 30% 即跳满。物理上限仍为 maxOutputTokens*4。
  const maxSummaryChars = summaryMaxTokens * COMPACTION_CONFIG.charsPerToken;
  const inputChars = summaryInput.length;
  let accumulated = '';
  let summaryUsage = null;
  const reportUsage = () => {
    try {
      onProviderUsage?.(summaryUsage);
    } catch {
      // Usage telemetry must not change compaction semantics.
    }
  };
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    try {
      // 分母随真实接收量动态扩张，保证 percent 单调、平滑、done 前不提前到满。
      const estimatedTotalChars = estimateSummaryChars({
        inputChars,
        maxSummaryChars,
        receivedChars: accumulated.length,
      });
      onProgress({ receivedChars: accumulated.length, estimatedTotalChars });
    } catch {
      // 进度回调不应影响主流程
    }
  };

  if (provider === 'anthropic') {
    // Anthropic: 流式，按 content_block_delta 累加文本并上报进度。
    const url = providerConfig.endpoint || `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = {
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: boundedSummaryInput },
        { role: 'user', content: COMPACT_PROMPT },
      ],
      max_tokens: summaryMaxTokens,
      // 注意：当前 Anthropic 模型（Vertex 上的 Claude）已弃用 temperature，
      // 传入会返回 400 invalid_request_error。与对话主路径对齐：不传 temperature。
      stream: true,
    };

    const res = await fetchWithConnectionRecovery(url, {
      method: 'POST',
      headers: providerConfig.headers || {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...buildClaudeCliIdentityHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    }, {
      ...connectionRecoveryOptions,
      webContents,
      streamId,
      provider,
      model,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logCompactionDiagnostic('summarize:http_error', {
        wire: 'anthropic',
        status: res.status,
        body: text.slice(0, 1000),
      });
      throw new Error(`Anthropic summary HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    await readSseStream(res, (payload) => {
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        return;
      }
      if (evt?.type === 'content_block_delta' && typeof evt?.delta?.text === 'string') {
        accumulated += evt.delta.text;
        reportProgress();
      }
      if (evt?.type === 'message_start' && evt?.message?.usage) {
        const usage = evt.message.usage;
        summaryUsage = {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        };
      }
      if (evt?.type === 'message_delta' && evt?.usage) {
        summaryUsage = {
          ...(summaryUsage || {}),
          outputTokens: evt.usage.output_tokens ?? 0,
        };
      }
    });

    logCompactionDiagnostic('summarize:done', {
      wire: 'anthropic',
      accumulatedChars: accumulated.length,
      empty: accumulated.length === 0,
    });
    reportUsage();
    return accumulated || null;
  }

  if (providerConfig.wire === 'openai-responses') {
    // OpenAI Responses: GPT 订阅链路，按 response.output_text.delta 累加文本并上报进度。
    const body = encodeOpenAIResponsesRequest({
      model,
      messages: summaryMessages,
      tools: [],
      maxOutputTokens: summaryMaxTokens,
      omitMaxOutputTokens: Boolean(providerConfig.omitMaxOutputTokens),
    });

    const res = await fetchWithConnectionRecovery(providerConfig.endpoint || `${baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: providerConfig.headers || {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'responses=experimental',
      },
      body: JSON.stringify(body),
      signal,
    }, {
      ...connectionRecoveryOptions,
      webContents,
      streamId,
      provider,
      model,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logCompactionDiagnostic('summarize:http_error', {
        wire: 'openai-responses',
        status: res.status,
        body: text.slice(0, 1000),
      });
      throw new Error(`OpenAI Responses summary HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    await readSseStream(res, (payload) => {
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        return;
      }
      if (evt?.type === 'response.output_text.delta' && typeof evt?.delta === 'string') {
        accumulated += evt.delta;
        reportProgress();
        return;
      }
      if (typeof evt?.response?.output_text === 'string') {
        accumulated += evt.response.output_text;
        reportProgress();
      }
      if (evt?.type === 'response.completed' && evt?.response?.usage) {
        const usage = evt.response.usage;
        const cached = usage.input_tokens_details?.cached_tokens
          ?? usage.prompt_tokens_details?.cached_tokens
          ?? 0;
        summaryUsage = {
          inputTokens: Math.max(0, (usage.input_tokens ?? 0) - cached),
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        };
      }
    });

    logCompactionDiagnostic('summarize:done', {
      wire: 'openai-responses',
      accumulatedChars: accumulated.length,
      empty: accumulated.length === 0,
    });
    reportUsage();
    return accumulated || null;
  }

  // OpenAI: 流式，按 choices[].delta.content 累加文本并上报进度。
  const url = providerConfig.endpoint || `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: summaryMessages,
    max_completion_tokens: summaryMaxTokens,
    temperature: COMPACTION_CONFIG.summaryTemperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  const res = await fetchWithConnectionRecovery(url, {
    method: 'POST',
    headers: providerConfig.headers || {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  }, {
    ...connectionRecoveryOptions,
    webContents,
    streamId,
    provider,
    model,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logCompactionDiagnostic('summarize:http_error', {
      wire: 'openai',
      status: res.status,
      body: text.slice(0, 1000),
    });
    throw new Error(`OpenAI summary HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  await readSseStream(res, (payload) => {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = evt?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      accumulated += delta;
      reportProgress();
    }
    if (evt?.usage) {
      const cached = evt.usage.prompt_tokens_details?.cached_tokens
        ?? evt.usage.prompt_cache_hit_tokens
        ?? 0;
      summaryUsage = {
        inputTokens: Math.max(0, (evt.usage.prompt_tokens ?? 0) - cached),
        outputTokens: evt.usage.completion_tokens ?? 0,
        cacheReadTokens: cached,
        cacheWriteTokens: 0,
      };
    }
  });

  logCompactionDiagnostic('summarize:done', {
    wire: 'openai',
    accumulatedChars: accumulated.length,
    empty: accumulated.length === 0,
  });
  reportUsage();
  return accumulated || null;
}

// ── Improved Structural Summary（Fallback Tier 1）──

function summarizeOldMessages(oldMessages) {
  const parts = [];

  // Group by turn: each assistant message + preceding user message = one turn
  let turnCounter = 0;
  let currentUser = null;

  for (const m of oldMessages) {
    if (isHumanUserMessage(m)) {
      currentUser = m;
    } else if (m.role === 'assistant') {
      turnCounter++;
      parts.push(`\n### Turn ${turnCounter}`);
      if (currentUser) {
        const userContent =
          typeof currentUser.content === 'string'
            ? currentUser.content
            : JSON.stringify(currentUser.content);
        parts.push(
          `**User**: ${userContent.slice(0, 800)}${userContent.length > 800 ? '...' : ''}`,
        );
      } else {
        parts.push('**Context**: Continued execution inside the latest preserved user turn.');
      }

      // Extract tool calls
      const tcList =
        m.tool_calls ||
        (Array.isArray(m.content)
          ? m.content
              .filter((b) => b.type === 'tool_use')
              .map((b) => ({ name: b.name, input: b.input }))
          : null);

      if (tcList?.length) {
        const tools = tcList
          .map((tc) => {
            const name =
              tc.function?.name || tc.name || 'unknown';
            const args =
              tc.function?.arguments || tc.input || '';
            const argsStr =
              typeof args === 'string' ? args : JSON.stringify(args);
            return `${name}(${argsStr.slice(0, 300)}${argsStr.length > 300 ? '...' : ''})`;
          })
          .join(', ');
        parts.push(`**Assistant**: Executed ${tools}`);
      }

      // Extract text content
      const textContent =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join(' ')
            : '';

      if (textContent && textContent.length > 5) {
        parts.push(
          `  Response: ${textContent.slice(0, 500)}${textContent.length > 500 ? '...' : ''}`,
        );
      }

      currentUser = null;
    } else if (messageHasToolResult(m)) {
      const toolResultContent = typeof m.content === 'string'
        ? m.content
        : JSON.stringify(m.content);
      parts.push(
        `**Tool result**: ${toolResultContent.slice(0, 800)}${toolResultContent.length > 800 ? '...' : ''}`,
      );
    }
  }

  // Handle remaining user messages without assistant response
  if (currentUser) {
    const content =
      typeof currentUser.content === 'string'
        ? currentUser.content
        : JSON.stringify(currentUser.content);
    parts.push(`\n### Turn ${turnCounter + 1}`);
    parts.push(
      `**User**: ${content.slice(0, 800)}${content.length > 800 ? '...' : ''}`,
    );
  }

  return parts.length > 0
    ? `## Conversation Summary\n${parts.join('\n')}`
    : null;
}

// ── Build Compacted Messages ──

/**
 * Prefer the recent tail near the compaction point when summary input exceeds budget.
 * Head-first truncation drops the newest decisions (e.g. multi-option plans, "方案2").
 */
function truncateSummaryInputPreferTail(text, maxChars) {
  const value = String(text ?? '');
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0) return '';
  if (value.length <= limit) return value;
  const marker = '\n...[summary input truncated: kept recent tail near compaction point; older head omitted]...\n';
  if (limit <= marker.length) return value.slice(-limit);
  const tailBudget = limit - marker.length;
  return `${marker}${value.slice(-tailBudget)}`;
}

/**
 * Token-aware tail truncation. Uses the shared CJK/JSON-sensitive estimator directly rather than
 * converting a token budget back into `tokens * 4` characters (the source of the 461k→928k miss).
 */
function truncateSummaryInputToTokenBudget(text, maxTokens) {
  const value = String(text ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit)) return value;
  if (limit <= 0) return '';
  if (estimateTextTokens(value) <= limit) return value;

  const marker = '\n...[summary input truncated by conservative token budget; kept recent tail near compaction point]...\n';
  if (estimateTextTokens(marker) >= limit) return '';

  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = `${marker}${value.slice(-mid)}`;
    if (estimateTextTokens(candidate) <= limit) low = mid;
    else high = mid - 1;
  }
  return `${marker}${value.slice(-low)}`;
}

/**
 * Strip recursive carry-forward wrappers so re-merge does not nest prior merged blobs.
 * Keeps the semantic body; drops structural headers added by previous merges.
 */
function flattenSummaryForCarryForward(summary) {
  let text = String(summary ?? '').trim();
  if (!text) return '';
  // Iteratively peel nested wrappers from prior merges.
  for (let i = 0; i < 8; i += 1) {
    const before = text;
    text = text
      .replace(/^##\s*Carry-forward summary from previous compaction\s*\n+/i, '')
      .replace(/^##\s*Delta summary since previous compaction\s*\([^)]*\)\s*\n+/gim, '')
      .replace(/^###\s*Previous compacted context\s+\d+\s*\n+/gim, '')
      .replace(/^id:\s*.+\n/gim, '')
      .replace(/^method:\s*.+\n/gim, '')
      .replace(/^representedMessages:\s*.+\n/gim, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text === before) break;
  }
  return text;
}

/**
 * Pull recent user decision / multi-option anchors that must survive handoff even if
 * LLM summary drifts toward older topics.
 */
function extractRecentDecisionAnchors(messages, { limit = 8, maxChars = 900 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const anchors = [];
  const decisionLike = /方案\s*[0-9一二三四五六七八九十]+|option\s*[1-9a-c]|选择|就按|用这个|按这个|选第|采纳|确认按|按方案/i;
  const multiOption = /方案\s*[1-9一二三]|Option\s*[1-9A-C]|方案一|方案二|方案三/i;

  for (let i = list.length - 1; i >= 0 && anchors.length < limit; i -= 1) {
    const message = list[i];
    if (!message || message.role !== 'user' || message._compaction) continue;
    const raw = typeof message.content === 'string'
      ? message.content.trim()
      : Array.isArray(message.content)
        ? message.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim()
        : '';
    if (!raw) continue;
    if (raw.startsWith('[上下文交接') || raw.startsWith('## Carry-forward')) continue;

    const shortDecision = raw.length <= 240;
    const looksLikeDecision = decisionLike.test(raw) || (multiOption.test(raw) && raw.length > 40);
    if (!shortDecision && !looksLikeDecision) continue;

    const clipped = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    // de-dupe exact repeats
    if (!anchors.includes(clipped)) anchors.push(clipped);
  }
  return anchors.reverse();
}

function formatDecisionAnchorsSection(anchors) {
  const items = Array.isArray(anchors) ? anchors.filter((item) => typeof item === 'string' && item.trim()) : [];
  if (!items.length) return '';
  return [
    '## 最近用户决策与方案锚点',
    '以下为压缩点附近必须保留的用户决策/多方案结论，后续执行不得丢弃或改写成无关旧话题：',
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}

function buildHandoffContent({ compactSummary, oldCount, decisionAnchors = [] }) {
  const summary = compactSummary?.trim()
    || 'Earlier conversation was removed from the active prompt because compaction summary generation was unavailable. Continue from the recent messages and ask for clarification if required.';
  const decisionSection = formatDecisionAnchorsSection(decisionAnchors);
  // Avoid duplicating anchors when they were already embedded into the stored summary.
  const summaryHasAnchors = summary.includes('## 最近用户决策与方案锚点');
  const leadingDecision = decisionSection && !summaryHasAnchors ? [decisionSection, ''] : [];

  return [
    `[上下文交接 - 共压缩 ${oldCount} 条消息]`,
    '',
    '以下是之前工作进展的压缩交接。请基于这份交接和后续保留的最近消息继续任务，不要重复已经完成的工作。',
    '',
    ...leadingDecision,
    '## 已完成的工作与关键上下文',
    summary,
    '',
    '## 继续执行要求',
    '- 优先承接用户最近的明确要求与上方决策锚点。',
    '- 如果交接摘要和最近消息冲突，以最近消息与决策锚点为准。',
    '- 如需核验证据，优先使用本地工具按需读取文件、命令输出或 artifact，而不是要求用户重新提供上下文。',
  ].join('\n');
}

function normalizeContinuityContext(continuityContext = []) {
  if (!Array.isArray(continuityContext)) return [];
  return continuityContext
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => ({
      id: typeof item.id === 'string' ? item.id : `continuity-${index}`,
      method: typeof item.method === 'string' ? item.method : 'unknown',
      originalMessageCount: Number.isFinite(item.originalMessageCount) ? item.originalMessageCount : 0,
      beforeTokens: Number.isFinite(item.beforeTokens) ? item.beforeTokens : 0,
      afterTokens: Number.isFinite(item.afterTokens) ? item.afterTokens : 0,
      summary: typeof item.summary === 'string' ? item.summary : '',
      checkpointVersion: Number.isFinite(item.checkpointVersion) ? Math.floor(item.checkpointVersion) : null,
      budgetSnapshot: item.budgetSnapshot && typeof item.budgetSnapshot === 'object'
        ? item.budgetSnapshot
        : null,
      canonicalCheckpoint: item.canonicalCheckpoint && typeof item.canonicalCheckpoint === 'object'
        ? item.canonicalCheckpoint
        : null,
      coldHistoryRefs: Array.isArray(item.coldHistoryRefs)
        ? item.coldHistoryRefs.filter((ref) => typeof ref === 'string' && ref.trim())
        : [],
    }))
    .filter((item) => item.summary.trim() || item.originalMessageCount > 0 || item.canonicalCheckpoint);
}

function buildContinuityCarryForwardSummary(
  continuityContext,
  maxTokens = COMPACTION_CONFIG.legacyCarryForwardFallbackTokens,
) {
  const items = normalizeContinuityContext(continuityContext);
  if (!items.length || maxTokens <= 0) return '';
  // Only carry the latest continuity item, flatten prior wrappers, then bound the body itself.
  // Legacy sessions may contain hundreds of thousands of tokens in one _compaction.summary;
  // treating that body as immutable makes every later compaction mathematically impossible.
  const latest = items[items.length - 1];
  const flattened = flattenSummaryForCarryForward(latest.summary)
    || latest.summary.trim()
    || '[previous compacted context summary unavailable]';
  return truncateSummaryInputToTokenBudget(flattened, maxTokens);
}

function uniqueNonEmptyStrings(values, limit = 24) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function collectTextFromMessages(messages, limit = 12) {
  const texts = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (typeof message?.content === 'string' && message.content.trim()) {
      texts.push(message.content);
    } else if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (typeof block?.content === 'string' && block.content.trim()) {
          texts.push(block.content);
        } else if (typeof block?.text === 'string' && block.text.trim()) {
          texts.push(block.text);
        }
      }
    }
    if (Array.isArray(message?.segments)) {
      for (const segment of message.segments) {
        if (typeof segment?.content === 'string' && segment.content.trim()) {
          texts.push(segment.content);
        }
        if (typeof segment?.result === 'string' && segment.result.trim()) {
          texts.push(segment.result);
        } else if (segment?.result != null) {
          try {
            texts.push(JSON.stringify(segment.result));
          } catch {
            // ignore non-serializable segment results
          }
        }
      }
    }
    if (texts.length >= limit) break;
  }
  return texts.slice(0, limit);
}

/**
 * Candidate acceptance is not "summary generated".
 * It must prove final-request budget and mandatory semantic coverage.
 */
function evaluateCompactionCandidate({
  candidateMessages,
  decisionAnchors = [],
  requestTargetTokens = null,
  beforeRequestTokens = null,
  triggerLimit = null,
  tools = [],
}) {
  const marker = Array.isArray(candidateMessages)
    ? candidateMessages.find((message) => message?._compaction)?._compaction
    : null;
  const checkpoint = marker?.canonicalCheckpoint && typeof marker.canonicalCheckpoint === 'object'
    ? marker.canonicalCheckpoint
    : null;
  const coldHistoryRefs = Array.isArray(marker?.coldHistoryRefs)
    ? marker.coldHistoryRefs
    : Array.isArray(checkpoint?.coldHistoryRefs)
      ? checkpoint.coldHistoryRefs
      : [];
  const preservedDecisions = Array.isArray(checkpoint?.decisions)
    ? checkpoint.decisions
    : Array.isArray(marker?.decisionAnchors)
      ? marker.decisionAnchors
      : [];
  const requiredDecisions = uniqueNonEmptyStrings(decisionAnchors, 16);
  const missingDecisions = requiredDecisions.filter(
    (decision) => !preservedDecisions.some((item) => String(item).includes(decision) || decision.includes(String(item))),
  );
  const budget = estimateFinalRequestBudget(candidateMessages, tools);
  const requestTargetOk = !Number.isFinite(requestTargetTokens)
    || budget.finalRequestTokens <= requestTargetTokens;
  const reducedOk = !Number.isFinite(beforeRequestTokens)
    || budget.finalRequestTokens < beforeRequestTokens;
  const triggerOk = !Number.isFinite(triggerLimit)
    || budget.finalRequestTokens <= triggerLimit;
  const narrative = typeof checkpoint?.recentNarrative === 'string'
    ? checkpoint.recentNarrative.trim()
    : typeof marker?.summary === 'string'
      ? marker.summary.trim()
      : '';
  const narrativeOk = narrative.length >= COMPACTION_CONFIG.minCanonicalNarrativeChars;
  const coverageOk = Boolean(marker) && narrativeOk && missingDecisions.length === 0;
  // Commit gate: reduced + under trigger + growth-aware request target + semantic coverage.
  // A candidate below trigger but above requestTarget would immediately retrigger after one turn.
  return {
    accepted: reducedOk && triggerOk && requestTargetOk && coverageOk,
    preferred: reducedOk && triggerOk && requestTargetOk && coverageOk,
    budget,
    requestTargetOk,
    reducedOk,
    triggerOk,
    coverageOk,
    missingDecisions,
    coldHistoryRefs,
    coverageSnapshot: {
      decisionCount: preservedDecisions.length,
      requiredDecisionCount: requiredDecisions.length,
      coldHistoryRefCount: coldHistoryRefs.length,
      hasRecentNarrative: narrativeOk,
      missingDecisions,
    },
  };
}

function collectColdHistoryFromSources(sources) {
  const artifactRefs = [];
  const paths = [];
  const suggestedRetrieval = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const clues = extractRecoverableClues(source, { limit: 16 });
    artifactRefs.push(...(clues.artifactRefs || []));
    paths.push(...(clues.paths || []));
    suggestedRetrieval.push(...(clues.suggestedRetrieval || []));
  }
  return {
    artifactRefs: uniqueNonEmptyStrings(artifactRefs, 24),
    paths: uniqueNonEmptyStrings(paths, 24),
    suggestedRetrieval: uniqueNonEmptyStrings(suggestedRetrieval, 24),
  };
}

/**
 * Compile a versioned canonical checkpoint.
 * Narrative is a rendering of this structure; recursive legacy wrappers are only migration inputs.
 */
function compileCanonicalCheckpoint({
  continuityContext = [],
  compactSummary = '',
  oldCount = 0,
  decisionAnchors = [],
  deltaInputMessages = [],
  keepMessages = [],
  budgetSnapshot = null,
  checkpointVersion = 2,
} = {}) {
  const continuityItems = normalizeContinuityContext(continuityContext);
  const previous = continuityItems.length ? continuityItems[continuityItems.length - 1] : null;
  const previousCheckpoint = previous?.canonicalCheckpoint && typeof previous.canonicalCheckpoint === 'object'
    ? previous.canonicalCheckpoint
    : null;
  const previousNarrative = previous
    ? flattenSummaryForCarryForward(previous.summary) || previous.summary.trim()
    : '';
  const deltaNarrative = flattenSummaryForCarryForward(compactSummary)
    || (typeof compactSummary === 'string' ? compactSummary.trim() : '')
    || `No semantic delta summary was available for the ${oldCount} newly compacted messages.`;
  const decisions = uniqueNonEmptyStrings([
    ...(Array.isArray(previousCheckpoint?.decisions) ? previousCheckpoint.decisions : []),
    ...(Array.isArray(decisionAnchors) ? decisionAnchors : []),
  ], 16);
  const coldHistory = collectColdHistoryFromSources([
    previousNarrative,
    deltaNarrative,
    ...collectTextFromMessages(deltaInputMessages, 8),
    ...collectTextFromMessages(keepMessages, 4),
    ...(Array.isArray(previousCheckpoint?.coldHistoryRefs) ? previousCheckpoint.coldHistoryRefs : []),
    ...(Array.isArray(previous?.coldHistoryRefs) ? previous.coldHistoryRefs : []),
  ]);
  const coldHistoryRefs = uniqueNonEmptyStrings([
    ...coldHistory.artifactRefs,
    ...coldHistory.paths,
    ...coldHistory.suggestedRetrieval,
  ], 36);
  const recentNarrative = truncateSummaryInputToTokenBudget(
    [
      previousNarrative ? `## Previous continuity\n${previousNarrative}` : '',
      `## Delta since previous checkpoint (${oldCount} messages)\n${deltaNarrative}`,
      decisions.length
        ? `## Recent decisions\n${decisions.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
        : '',
      coldHistoryRefs.length
        ? `## Cold history refs\n${coldHistoryRefs.map((item) => `- ${item}`).join('\n')}`
        : '',
    ].filter(Boolean).join('\n\n'),
    Math.max(
      1,
      budgetSnapshot?.handoffMaxTokens
        || COMPACTION_CONFIG.legacyCarryForwardFallbackTokens,
    ),
  ).trim();

  return {
    checkpointVersion,
    sourceRevision: {
      previousMessageCount: countContinuityMessages(continuityContext),
      deltaMessageCount: Math.max(0, oldCount || 0),
      previousCheckpointVersion: previousCheckpoint?.checkpointVersion
        || previous?.checkpointVersion
        || null,
      migratedFromLegacy: !previousCheckpoint && Boolean(previousNarrative),
    },
    decisions,
    openWork: uniqueNonEmptyStrings(previousCheckpoint?.openWork, 12),
    completedWork: uniqueNonEmptyStrings(previousCheckpoint?.completedWork, 12),
    coldHistoryRefs,
    coldHistory,
    recentNarrative,
    budgetSnapshot: budgetSnapshot && typeof budgetSnapshot === 'object'
      ? { ...budgetSnapshot }
      : null,
    coverageSnapshot: {
      decisionCount: decisions.length,
      coldHistoryRefCount: coldHistoryRefs.length,
      hasRecentNarrative: Boolean(recentNarrative),
    },
  };
}

function mergeContinuityAndDeltaSummary({
  continuityContext,
  compactSummary,
  oldCount,
  decisionAnchors = [],
  maxTokens = COMPACTION_CONFIG.legacyCarryForwardFallbackTokens,
  deltaInputMessages = [],
  keepMessages = [],
  budgetSnapshot = null,
}) {
  // Prefer the versioned checkpoint narrative so recursive wrappers never become continuity truth.
  const checkpoint = compileCanonicalCheckpoint({
    continuityContext,
    compactSummary,
    oldCount,
    decisionAnchors,
    deltaInputMessages,
    keepMessages,
    budgetSnapshot: {
      ...(budgetSnapshot && typeof budgetSnapshot === 'object' ? budgetSnapshot : {}),
      handoffMaxTokens: maxTokens,
    },
  });
  return truncateSummaryInputToTokenBudget(checkpoint.recentNarrative, maxTokens).trim();
}

function countContinuityMessages(continuityContext) {
  return normalizeContinuityContext(continuityContext)
    .reduce((sum, item) => sum + Math.max(0, item.originalMessageCount || 0), 0);
}

/**
 * Budget degrade for the keep window.
 *
 * Summary-only fallbacks (llm → structural → fallback_drop) never touch keep/tools.
 * When preserveLatestUserTurn leaves a huge current-turn tool tail in keep, those
 * candidates cannot pass triggerLimit. Re-run microcompact on keep with
 * keepRecentCount=0 so even the latest turn's oversized tool_result payloads
 * become evidence previews, without dropping the turn structure itself.
 */
function degradeKeepMessagesForBudget(keepMessages) {
  if (!Array.isArray(keepMessages) || keepMessages.length === 0) {
    return { messages: keepMessages, degraded: false, stats: null };
  }

  const result = microcompactMessagesForContext(keepMessages, {
    // Include the latest turn; default microcompact protects recent non-system msgs.
    keepRecentCount: 0,
    // More aggressive than the pre-split pass so keep-local tool tails shrink further.
    triggerChars: 1_500,
    previewChars: 400,
  });

  return {
    messages: result.messages,
    degraded: (result.stats?.compactedCount ?? 0) > 0,
    stats: result.stats ?? null,
  };
}

function buildCompactedMessages({
  systemPrompt,
  compactSummary,
  oldCount,
  keepMessages,
  method,
  beforeTokens,
  afterTokens,
  continuityContext = [],
  fallbackReason = null,
  fallbackDetail = null,
  decisionAnchors = [],
  handoffMaxTokens = COMPACTION_CONFIG.legacyCarryForwardFallbackTokens,
  budgetSnapshot = null,
  deltaInputMessages = [],
}) {
  const result = [{ role: 'system', content: systemPrompt }];
  const previousMessageCount = countContinuityMessages(continuityContext);
  const representedMessageCount = previousMessageCount + oldCount;
  const anchors = Array.isArray(decisionAnchors) ? decisionAnchors : [];
  const effectiveBudgetSnapshot = {
    ...(budgetSnapshot && typeof budgetSnapshot === 'object' ? budgetSnapshot : {}),
    handoffMaxTokens,
  };
  const canonicalCheckpoint = compileCanonicalCheckpoint({
    continuityContext,
    compactSummary,
    oldCount,
    decisionAnchors: anchors,
    deltaInputMessages,
    keepMessages,
    budgetSnapshot: effectiveBudgetSnapshot,
  });
  const mergedSummary = truncateSummaryInputToTokenBudget(
    canonicalCheckpoint.recentNarrative || '',
    handoffMaxTokens,
  ).trim();

  result.push({
    role: 'user',
    content: buildHandoffContent({
      compactSummary: mergedSummary,
      oldCount: representedMessageCount,
      // Anchors already embedded in mergedSummary for continuity persistence;
      // still pass explicitly so handoff rendering stays robust if summary is empty.
      decisionAnchors: anchors,
    }),
    _compaction: buildCompactionMarker({
      method,
      fallbackReason,
      fallbackDetail,
      originalMessageCount: representedMessageCount,
      deltaMessageCount: oldCount,
      previousMessageCount,
      beforeTokens,
      afterTokens,
      // Narrative is a rendering of the versioned checkpoint, not recursive legacy wrappers.
      summary: mergedSummary || '',
      decisionAnchors: anchors,
      checkpointVersion: 2,
      budgetSnapshot: effectiveBudgetSnapshot,
      canonicalCheckpoint,
      coldHistoryRefs: canonicalCheckpoint.coldHistoryRefs,
    }),
  });

  result.push(...keepMessages);
  return result;
}

function setCompactionAfterTokens(messages, afterTokens) {
  for (const m of messages) {
    if (m?._compaction) {
      m._compaction = {
        ...m._compaction,
        afterTokens,
      };
    }
  }
}

// ── Main Orchestrator ──

/**
 * 压缩入口 — 每轮 agent loop 开始前调用
 *
 * @param {object} params
 * @param {Array} params.messages - 当前完整消息列表
 * @param {string} params.systemPrompt - 原始 system prompt
 * @param {number} params.contextWindow - provider 配置的上下文窗口
 * @param {object} params.providerConfig - { provider, baseUrl, apiKey, model }
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{compacted: boolean, messages: Array, notification?: object}>}
 */
export async function compactIfNeeded({
  messages,
  systemPrompt,
  contextWindow,
  providerConfig,
  signal,
  force = false,
  continuityContext = [],
  onProgress,
  webContents = null,
  streamId = null,
  // circuit breaker 隔离域:优先 conversationId,缺省回退 streamId,避免跨会话串熔断状态。
  conversationId = null,
  connectionRecoveryOptions = {},
  tools = null,
  preserveLatestUserTurn = false,
  preserveRecentTurns = COMPACTION_CONFIG.preserveRecentTurns,
  // Goal 模式：传 true 或 partial GoalKeepPolicyConfig。有界 keep，替代无限 current-turn 保留。
  goalKeepPolicy = null,
  // 可选：provider 真实 usage（input + cacheRead）。ADR 52：仅诊断，不参与 Layer2 触发。
  // 触发只看下一请求投影估算（messages + tools schema）。
  usageTokens = null,
  onProviderUsage = null,
}) {
  const microcompactResult = microcompactMessagesForContext(messages);
  messages = microcompactResult.messages;
  const previousMessageCount = countContinuityMessages(continuityContext);
  const breakerScope = conversationId || streamId || null;
  // Goal keep 优先于 preserveLatestUserTurn；两者同时传入时以 goal keep 为准。
  const effectiveGoalKeepPolicy = goalKeepPolicy || null;
  let goalKeepMeta = null;

  // Circuit breaker: stop trying if we've failed too many times
  if (isCircuitBreakerTripped(breakerScope)) {
    // Still do basic structural compaction + drop as last resort
    let { keep, old, goalKeep } = splitForCompaction(messages, {
      preserveLatestUserTurn,
      preserveRecentTurns,
      goalKeepPolicy: effectiveGoalKeepPolicy,
      contextWindow,
      recoveryLevel: 0,
    });
    goalKeepMeta = goalKeep;
    if (old.length === 0) return { compacted: false, messages };

    const beforeTokens = estimateTokensFromMessages(messages);
    // Emergency: just keep recent messages
    const decisionAnchors = extractRecentDecisionAnchors(old);
    const result = buildCompactedMessages({
      systemPrompt,
      compactSummary: null,
      oldCount: old.length,
      keepMessages: keep,
      method: 'fallback_drop',
      beforeTokens,
      afterTokens: estimateTokensFromMessages([
        { role: 'system', content: systemPrompt },
        ...keep,
      ]),
      continuityContext,
      fallbackReason: 'circuit_breaker',
      fallbackDetail: 'LLM summary circuit breaker tripped after repeated failures',
      decisionAnchors,
      deltaInputMessages: old,
    });

    console.warn(
      `[context-compactor] Circuit breaker active — dropped ${old.length} messages without summary`,
    );

    return {
      compacted: true,
      messages: result,
      notification: {
        method: 'fallback_drop',
        fallbackReason: 'circuit_breaker',
        fallbackDetail: 'LLM summary circuit breaker tripped after repeated failures',
        beforeTokens,
        afterTokens: estimateTokensFromMessages(result),
        oldMessageCount: old.length,
        previousMessageCount,
        totalMessageCount: previousMessageCount + old.length,
        keptMessageCount: keep.length,
      },
    };
  }

  // Estimate current tokens（含工具 schema：tools 每次请求都全量发送，必须计入触发口径，
  // 否则会出现「进度条/触发器都没算工具，但 provider 已超窗」）。
  // ADR 52：触发只看下一请求投影估算；usageTokens 参数保留兼容，不抬高触发水位。
  const beforeBudget = estimateFinalRequestBudget(messages, tools);
  const estimatedLocal = beforeBudget.finalRequestTokens;
  const usageNum = Number.isFinite(usageTokens) && usageTokens > 0 ? usageTokens : null;
  void usageNum; // 诊断兼容字段，不参与 shouldRunCompaction
  const estimated = estimatedLocal;

  if (!shouldRunCompaction({ force, estimatedTokens: estimated, contextWindow, messages })) {
    // Layer 1 可能已压回 soft 线。保留 messages（已微压缩）并标记 microcompacted，
    // 让 coordinator 能回传有效上下文占用，而不是把原始高位继续显示给 UI。
    return {
      compacted: false,
      messages,
      microcompacted: Boolean(microcompactResult?.stats?.compactedCount > 0),
      microcompactStats: microcompactResult?.stats ?? null,
    };
  }

  // Split
  let { keep, old, goalKeep } = splitForCompaction(messages, {
    preserveLatestUserTurn,
    preserveRecentTurns,
    goalKeepPolicy: effectiveGoalKeepPolicy,
    contextWindow,
    recoveryLevel: 0,
  });
  goalKeepMeta = goalKeep;
  if (old.length === 0) {
    return { compacted: false, messages };
  }

  console.log(
    `[context-compactor] Compacting: est ${estimated} / ${contextWindow || 'unknown'} tokens, ${old.length} old messages → ${keep.length} kept${force ? ' (force)' : ''}`,
  );

  const beforeTokens = estimated;
  // `old` 是本次压缩必须覆盖并从持久化历史中替换掉的完整集合，不能被 PTL 重试改写。
  // LLM 重试只缩小临时候选；否则重试耗尽后的 structured fallback 与累计代表数都会漏掉头部消息。
  const llmOld = [...old];
  let summaryRetryTokenBudget = resolveSummaryTokenBudget(providerConfig, { contextWindow }).summaryMaxInputTokens;
  let compactSummary = null;
  let method = 'structural';
  // 记录"为什么没走 LLM / LLM 为什么失败"，让兜底原因在 Evidence 与 UI 可见。
  let fallbackReason = providerConfig ? null : 'no_provider';
  let fallbackDetail = providerConfig ? null : 'No LLM provider configured for summarization';

  // Tier 1: Try LLM semantic summary
  if (providerConfig) {
    try {
      for (let attempt = 1; attempt <= COMPACTION_CONFIG.maxPtlRetries; attempt++) {
        let usageReported = false;
        try {
          onProgress?.({
            progressStage: attempt === 1 ? 'summarizing' : 'retrying',
            attempt,
            maxAttempts: COMPACTION_CONFIG.maxPtlRetries,
            inputTokenBudget: summaryRetryTokenBudget,
          });
          const rawSummary = await summarizeWithLLM({
            oldMessages: llmOld,
            providerConfig,
            signal,
            onProgress,
            webContents,
            streamId,
            connectionRecoveryOptions,
            contextWindow,
            summaryInputTokenBudget: summaryRetryTokenBudget,
            onProviderUsage(usage) {
              usageReported = true;
              onProviderUsage?.(usage);
            },
            conversationId,
          });

          if (rawSummary) {
            compactSummary = formatCompactSummary(rawSummary);
            method = 'llm';
            console.log(
              `[context-compactor] LLM summary success (${compactSummary.length} chars, covered ${old.length} messages)`,
            );
            recordCompactionSuccess(breakerScope);
          }
          break; // success, exit retry loop
        } catch (err) {
          if (!usageReported) onProviderUsage?.(null);
          const errMsg = err?.message || '';
          const isPromptTooLong =
            errMsg.includes('prompt_too_long') ||
            errMsg.includes('context_length_exceeded') ||
            errMsg.includes('413') ||
            errMsg.includes('400') ||
            errMsg.includes('token');

          logCompactionDiagnostic('compact:attempt_error', {
            conversationId,
            attempt,
            maxPtlRetries: COMPACTION_CONFIG.maxPtlRetries,
            oldMessageCount: llmOld.length,
            originalOldMessageCount: old.length,
            isPromptTooLong,
            errorName: err?.name ?? null,
            errorMessage: errMsg.slice(0, 1000),
            errorCode: err?.code ?? err?.cause?.code ?? null,
          });

          if (isPromptTooLong && attempt < COMPACTION_CONFIG.maxPtlRetries) {
            // PTL retry 按实际摘要 payload token 预算几何收敛；消息全集保持不变，
            // 下一次 summarizeWithLLM 会在同一投影上保尾裁剪，因此请求体一定缩小且覆盖计数不变。
            const previousBudget = summaryRetryTokenBudget;
            summaryRetryTokenBudget = Math.max(256, Math.floor(previousBudget * 0.55));
            if (summaryRetryTokenBudget < previousBudget) {
              console.warn(
                `[context-compactor] PTL retry ${attempt}/${COMPACTION_CONFIG.maxPtlRetries}: payload budget ${previousBudget} → ${summaryRetryTokenBudget} tokens (full coverage remains ${old.length})`,
              );
              continue;
            }
          }
          throw err; // re-throw if not PTL or no more retries
        }
      }

      if (!compactSummary) {
        throw new Error('LLM summary returned empty');
      }
    } catch (err) {
      const detail = err?.message || String(err);
      console.warn(
        `[context-compactor] LLM summary failed: ${detail}, falling back to structural`,
      );
      // 归类失败原因：PTL（prompt 过长重试耗尽）/ 空返回 / 其它调用错误。
      if (detail.includes('LLM summary returned empty')) {
        fallbackReason = 'llm_empty';
      } else if (
        detail.includes('prompt_too_long') ||
        detail.includes('context_length_exceeded') ||
        detail.includes('413') ||
        detail.includes('token')
      ) {
        fallbackReason = 'llm_prompt_too_long';
      } else {
        fallbackReason = 'llm_error';
      }
      fallbackDetail = detail.slice(0, 500);
      onProgress?.({
        progressStage: 'fallback',
        attempt: COMPACTION_CONFIG.maxPtlRetries,
        maxAttempts: COMPACTION_CONFIG.maxPtlRetries,
      });
      logCompactionDiagnostic('compact:fallback', {
        conversationId,
        fallbackReason,
        errorName: err?.name ?? null,
        errorMessage: detail,
        errorCode: err?.code ?? err?.cause?.code ?? null,
        errorCause: err?.cause?.message ?? null,
      });
      recordCompactionFailure(breakerScope);
    }
  }

  // Shared candidate selection keeps Desktop and CLI on the same
  // LLM → structural → safe-drop order. Desktop still owns provider retries,
  // diagnostics, and summary formatting above.
  const summarySelection = await runCompactionSummaryCascade({
    oldMessages: old,
    summarizeWithLlm: compactSummary ? async () => compactSummary : undefined,
    summarizeStructurally: summarizeOldMessages,
    fallbackSummary: '',
  });
  compactSummary = summarySelection.summary;
  method = summarySelection.method === 'structured' ? 'structural' : summarySelection.method;
  if (method !== 'llm' && !fallbackReason) {
    // providerConfig 存在但 compactSummary 为空且未进 catch（理论兜底），标注未知。
    fallbackReason = providerConfig ? 'llm_unavailable' : fallbackReason;
  }

  // Build result. The handoff budget is derived from the final request target, not a semantic
  // constant. Recompute it whenever the mandatory keep set changes.
  const providerMaxOutputTokens = resolveSummaryTokenBudget({
    providerConfig,
    contextWindow,
  }).summaryMaxTokens;
  const buildBudgetPlan = (keepMessages) => planHandoffBudget({
    contextWindow,
    providerMaxOutputTokens,
    systemTokens: estimateTextTokens(systemPrompt),
    toolSchemaTokens: beforeBudget.toolTokens,
    mandatoryKeepTokens: estimateTokensFromMessages(keepMessages),
  });
  let handoffBudgetPlan = buildBudgetPlan(keep);
  const decisionAnchors = extractRecentDecisionAnchors(old);
  let result = buildCompactedMessages({
    systemPrompt,
    compactSummary,
    oldCount: old.length,
    keepMessages: keep,
    method,
    beforeTokens,
    afterTokens: 0, // computed below
    continuityContext,
    fallbackReason,
    fallbackDetail,
    decisionAnchors,
    handoffMaxTokens: handoffBudgetPlan.handoffMaxTokens,
    budgetSnapshot: handoffBudgetPlan,
    deltaInputMessages: old,
  });

  let afterBudget = estimateFinalRequestBudget(result, tools);
  let afterTokens = afterBudget.messageTokens;
  setCompactionAfterTokens(result, afterTokens);

  // 压缩不是“生成了摘要”就算成功：自动压缩必须同时满足两条验收条件：
  // 1) messages + tools 的总预算确实下降；2) 回到触发线以内。
  // 结构摘要在大量短消息场景可能比原文还大，LLM 也可能返回异常冗长摘要；此时降级为
  // 最小 handoff。若连最小 handoff + 必须保留的 user/tool 尾都无法过线，则明确失败，
  // 避免把“压后仍超窗”伪装成 compacted:true 后继续撞 provider。
  const toolTokens = beforeBudget.toolTokens;
  const triggerLimit = contextWindow
    ? Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio)
    : null;
  const requestTargetTokens = Number.isFinite(handoffBudgetPlan?.requestTargetTokens)
    ? handoffBudgetPlan.requestTargetTokens
    : (triggerLimit == null ? null : Math.max(1, triggerLimit - COMPACTION_CONFIG.safetyReserveTokens));
  let afterBudgetTokens = afterBudget.finalRequestTokens;
  const requiresBudgetAcceptance = shouldCompact(beforeBudget.finalRequestTokens, contextWindow);
  const evaluateCandidate = (candidateMessages) => evaluateCompactionCandidate({
    candidateMessages,
    decisionAnchors,
    requestTargetTokens,
    beforeRequestTokens: beforeBudget.finalRequestTokens,
    triggerLimit,
    tools,
  });
  const meetsBudgetAcceptance = () => {
    const evaluation = evaluateCandidate(result);
    afterBudget = evaluation.budget;
    afterBudgetTokens = evaluation.budget.finalRequestTokens;
    return evaluation.accepted;
  };

  if (requiresBudgetAcceptance && !meetsBudgetAcceptance()) {
    const rejectedMethod = method;
    const rejectedBudgetTokens = afterBudgetTokens;
    const alternatives = [];
    if (method === 'llm') {
      const structuralSummary = summarizeOldMessages(old);
      if (structuralSummary) alternatives.push({ method: 'structural', summary: structuralSummary });
    }
    alternatives.push({ method: 'fallback_drop', summary: null });

    let accepted = false;
    let minimalCandidateBudgetTokens = afterBudgetTokens;
    let activeKeep = keep;
    let keepBudgetDegraded = false;

    const tryCandidatesWithKeep = (keepMessages, reason, detail) => {
      const candidateBudgetPlan = buildBudgetPlan(keepMessages);
      let bestAccepted = null;
      for (const alternative of alternatives) {
        const candidate = buildCompactedMessages({
          systemPrompt,
          compactSummary: alternative.summary,
          oldCount: old.length,
          keepMessages,
          method: alternative.method,
          beforeTokens,
          afterTokens: 0,
          continuityContext,
          fallbackReason: reason,
          fallbackDetail: detail,
          decisionAnchors,
          handoffMaxTokens: candidateBudgetPlan.handoffMaxTokens,
          budgetSnapshot: candidateBudgetPlan,
          deltaInputMessages: old,
        });
        const evaluation = evaluateCompactionCandidate({
          candidateMessages: candidate,
          decisionAnchors,
          requestTargetTokens: candidateBudgetPlan.requestTargetTokens ?? requestTargetTokens,
          beforeRequestTokens: beforeBudget.finalRequestTokens,
          triggerLimit,
          tools,
        });
        const candidateBudget = evaluation.budget;
        const candidateAfterTokens = candidateBudget.messageTokens;
        setCompactionAfterTokens(candidate, candidateAfterTokens);
        const candidateBudgetTokens = candidateBudget.finalRequestTokens;
        minimalCandidateBudgetTokens = Math.min(minimalCandidateBudgetTokens, candidateBudgetTokens);
        if (!evaluation.accepted) continue;
        const acceptedCandidate = {
          candidate,
          alternative,
          candidateBudgetPlan,
          candidateBudget,
          candidateAfterTokens,
          candidateBudgetTokens,
          preferred: evaluation.preferred,
        };
        // Prefer candidates that also meet the growth-aware request target.
        if (evaluation.preferred) {
          bestAccepted = acceptedCandidate;
          break;
        }
        if (!bestAccepted) bestAccepted = acceptedCandidate;
      }
      if (!bestAccepted) return false;
      result = bestAccepted.candidate;
      handoffBudgetPlan = bestAccepted.candidateBudgetPlan;
      compactSummary = bestAccepted.alternative.summary;
      method = bestAccepted.alternative.method;
      fallbackReason = reason;
      fallbackDetail = detail;
      afterBudget = bestAccepted.candidateBudget;
      afterTokens = bestAccepted.candidateAfterTokens;
      afterBudgetTokens = bestAccepted.candidateBudgetTokens;
      activeKeep = keepMessages;
      return true;
    };

    const summaryFailDetail = `${rejectedMethod} candidate left ${rejectedBudgetTokens} tokens against trigger ${triggerLimit}`;
    accepted = tryCandidatesWithKeep(keep, 'insufficient_reduction', summaryFailDetail);

    // Summary-only alternatives leave keep/tools untouched. When the keep window
    // itself (esp. preserveLatestUserTurn / Goal tool tails) is the floor, degrade
    // keep payloads and retry before hard-failing.
    if (!accepted) {
      if (effectiveGoalKeepPolicy) {
        // Goal mode: climb recovery levels 3→5 (aggressive keep / skeleton / anchor).
        for (const level of [3, 4, 5]) {
          if (accepted) break;
          const reselected = splitForCompaction(messages, {
            preserveLatestUserTurn,
            preserveRecentTurns,
            goalKeepPolicy: effectiveGoalKeepPolicy,
            contextWindow,
            recoveryLevel: level,
          });
          if (!reselected.keep?.length) continue;
          keepBudgetDegraded = true;
          goalKeepMeta = reselected.goalKeep;
          const degradeDetail = `${summaryFailDetail}; goal keep recoveryLevel=${level} reason=${reselected.goalKeep?.reason ?? 'n/a'}`;
          logCompactionDiagnostic('compact:goal_keep_budget_degrade', {
            beforeTokens,
            triggerLimit,
            keptMessageCount: reselected.keep.length,
            recoveryLevel: level,
            keepTokens: reselected.goalKeep?.keepTokens ?? null,
            keepBudgetTokens: reselected.goalKeep?.keepBudgetTokens ?? null,
            reason: reselected.goalKeep?.reason ?? null,
          });
          accepted = tryCandidatesWithKeep(
            reselected.keep,
            'goal_keep_budget_degrade',
            degradeDetail,
          );
          if (accepted) {
            keep = reselected.keep;
            // old stays the original summarization set; keep is rebounded only.
          }
        }
      } else {
        const keepDegrade = degradeKeepMessagesForBudget(keep);
        if (keepDegrade.degraded) {
          keepBudgetDegraded = true;
          const degradeDetail = `${summaryFailDetail}; keep microcompact savedChars=${keepDegrade.stats?.savedChars ?? 0}`;
          logCompactionDiagnostic('compact:keep_budget_degrade', {
            beforeTokens,
            triggerLimit,
            keptMessageCount: keep.length,
            compactedCount: keepDegrade.stats?.compactedCount ?? 0,
            savedChars: keepDegrade.stats?.savedChars ?? 0,
          });
          accepted = tryCandidatesWithKeep(
            keepDegrade.messages,
            'keep_budget_degrade',
            degradeDetail,
          );
          if (accepted) {
            keep = keepDegrade.messages;
          }
        }
      }
    }

    if (!accepted) {
      const error = new Error(
        `Context compaction could not reduce the prompt below ${triggerLimit} tokens; minimal candidate=${minimalCandidateBudgetTokens}, before=${beforeBudget.finalRequestTokens}`,
      );
      error.code = 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION';
      logCompactionDiagnostic('compact:insufficient_reduction', {
        ...buildCompactionDiagnosticContext({
          conversationId,
          continuityContext,
          deltaInputMessages: old,
          deltaSummary: compactSummary,
          resultMessages: result,
          tools,
        }),
        beforeTokens,
        beforeRequestTokens: beforeBudget.finalRequestTokens,
        afterBudgetTokens: minimalCandidateBudgetTokens,
        triggerLimit,
        oldMessageCount: old.length,
        keptMessageCount: activeKeep.length,
        keepBudgetDegraded,
        goalKeep: goalKeepMeta,
      });
      throw error;
    }
  }

  console.log(
    `[context-compactor] Compaction complete: ${beforeBudget.finalRequestTokens} → ${afterBudgetTokens} tokens (method: ${method})`,
  );

  logCompactionDiagnostic('compact:complete', {
    ...buildCompactionDiagnosticContext({
      conversationId,
      continuityContext,
      deltaInputMessages: old,
      deltaSummary: compactSummary,
      resultMessages: result,
      tools,
    }),
    method,
    fallbackReason,
    beforeTokens,
    beforeRequestTokens: beforeBudget.finalRequestTokens,
    afterTokens,
    afterBudgetTokens,
    triggerLimit,
    oldMessageCount: old.length,
    summaryChars: typeof compactSummary === 'string' ? compactSummary.length : 0,
  });

  return {
    compacted: true,
    messages: result,
    goalKeep: goalKeepMeta,
    notification: {
      method,
      fallbackReason,
      fallbackDetail,
      beforeTokens,
      afterTokens,
      oldMessageCount: old.length,
      previousMessageCount,
      totalMessageCount: previousMessageCount + old.length,
      keptMessageCount: keep.length,
      goalKeep: goalKeepMeta,
    },
  };
}

export {
  COMPACTION_CONFIG,
  estimateTokensFromMessages,
  estimateTextTokens,
  estimateToolsTokens,
  estimateSummaryChars,
  formatCompactSummary,
  extractRecoverableClues,
  microcompactMessagesForContext,
  resolveSummaryTokenBudget,
  truncateSummaryInputPreferTail,
  truncateSummaryInputToTokenBudget,
  flattenSummaryForCarryForward,
  extractRecentDecisionAnchors,
  mergeContinuityAndDeltaSummary,
  compileCanonicalCheckpoint,
  evaluateCompactionCandidate,
  buildHandoffContent,
  degradeKeepMessagesForBudget,
  summarizeOldMessages,
  planHandoffBudget,
};
