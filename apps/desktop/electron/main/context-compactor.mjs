/**
 * Context Compactor — 对标 Claude Code 的三层压缩体系
 *
 * Layer 1: 每轮 token 检查 (compactIfNeeded)
 * Layer 2: LLM 语义压缩 (summarizeWithLLM) → 结构摘要 fallback → 直接丢弃
 * Layer 3: 手动 /compact 指令（通过 chat:compact IPC handler）
 */

import {
  COMPACTION_SUMMARY_PROMPT as COMPACT_PROMPT,
  COMPACTION_SUMMARY_SYSTEM_PROMPT as SUMMARY_SYSTEM_PROMPT,
  CONTEXT_PROJECTION_CONFIG,
  estimateContextMessagesTokens,
  estimateContextTextTokens,
  estimateContextToolsTokens,
  formatCompactionMessagesForSummary,
  runCompactionSummaryCascade,
  splitMessagesForCompaction,
} from '@peer-agent/runtime-core';
import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';
import { encodeOpenAIResponsesRequest } from './provider-encoders/responses-encoder.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { logCompactionDiagnostic } from './compaction-diagnostic-log.mjs';
import { neutralizeToolCallSyntax } from './chat-runtime/message-sanitizer.mjs';

const COMPACTION_CONFIG = {
  // Token 投影与自动压缩阈值只有 runtime-core 一份真值；Desktop 这里只追加摘要执行参数。
  ...CONTEXT_PROJECTION_CONFIG,
  // 摘要输出上限不再写死：在 summarizeWithLLM 内复用当前模型的 maxOutputTokens，
  // 未配置时回退到 12000，避免长摘要被小上限截断（压缩后内容看不全）。
  summaryMaxInputTokens: 80_000,   // 摘要输入的上限（旧消息文本）
  summaryTemperature: 0.2,
  maxPtlRetries: 3,
  circuitBreakerThreshold: 3,
  // ── 进度估算（进度条分母）──
  // 摘要产出长度 ≈ 输入对话长度 × 压缩比。经验值：语义摘要约把原文压到 ~12%。
  // 用它而非「模型最大输出容量(maxOutputTokens*4)」作分母，避免进度收尾约 30% 即跳满。
  summaryCompressionRatio: 0.12,
  // 估算下限，避免极短对话时分母过小导致进度瞬间满。
  minEstimatedSummaryChars: 1_200,
  // 摘要生成默认输出预算；provider 未配置 maxOutputTokens 时回退到此值。
  defaultSummaryMaxTokens: 12_000,
  // 自动压缩触发时预留给「摘要输出」的 token，避免窗口顶满后摘要请求自身失败。
  summaryOutputReserveTokens: 4_000,
  // 额外安全区：provider framing / 工具 schema 抖动 / 估算误差。
  safetyReserveTokens: 1_000,
};

const MICROCOMPACTION_CONFIG = {
  keepRecentCount: 8,
  triggerChars: 6_000,
  previewChars: 800,
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

// ── Historical Tool Result Microcompaction ──

function previewHistoricalText(text, maxChars = MICROCOMPACTION_CONFIG.previewChars) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const headChars = Math.max(200, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(160, maxChars - headChars - 80);
  return `${value.slice(0, headChars)}\n...[historical context preview truncated: ${value.length} chars]...\n${value.slice(-tailChars)}`;
}

function tryParseJsonObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickDefined(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source?.[field] !== undefined) result[field] = source[field];
  }
  return result;
}

function compactLocalRefPayload(payload, previewChars) {
  if (payload?.kind === 'local_tool_result_ref') {
    const compacted = {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local tool result compacted; use artifact paths or suggestedRetrieval for full output.',
      ...pickDefined(payload, [
        'tool',
        'command',
        'cwd',
        'status',
        'exitCode',
        'stdoutPath',
        'stderrPath',
        'metadataPath',
        'artifactRef',
        'artifactRefs',
        'stdoutChars',
        'stderrChars',
        'stdoutLines',
        'stderrLines',
        'contextPreviewTruncated',
        'suggestedRetrieval',
      ]),
    };
    if (payload.stdoutPreview) {
      compacted.stdoutPreview = previewHistoricalText(payload.stdoutPreview, previewChars);
    }
    if (payload.stderrPreview) {
      compacted.stderrPreview = previewHistoricalText(payload.stderrPreview, Math.min(previewChars, 400));
    }
    return compacted;
  }

  if (payload?.kind === 'local_file_ref') {
    return {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local file read compacted; use path or suggestedRetrieval for full content.',
      ...pickDefined(payload, [
        'tool',
        'path',
        'chars',
        'lines',
        'mtimeMs',
        'sizeBytes',
        'contentHash',
        'fullRead',
        'contextPreviewTruncated',
        'suggestedRetrieval',
      ]),
      preview: previewHistoricalText(payload.preview ?? '', previewChars),
    };
  }

  if (payload?.kind === 'local_capability_result_ref') {
    const outputPreview = payload.outputPreview && typeof payload.outputPreview === 'object'
      ? compactCapabilityOutputPreview(payload.outputPreview, previewChars)
      : payload.outputPreview;
    return {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local capability result compacted; use artifact paths or suggestedRetrieval for full output.',
      ...pickDefined(payload, [
        'tool',
        'capabilityId',
        'status',
        'artifactRef',
        'artifactRefs',
        'suggestedRetrieval',
      ]),
      outputPreview,
    };
  }

  return null;
}

function compactCapabilityOutputPreview(preview, previewChars) {
  const next = {
    ...pickDefined(preview, [
      'status',
      'tool',
      'capabilityId',
      'cwd',
      'exitCode',
      'stdoutPath',
      'stderrPath',
      'metadataPath',
      'artifactRef',
      'artifactRefs',
      'stdoutChars',
      'stderrChars',
      'stdoutLines',
      'stderrLines',
      'contextPreviewTruncated',
      'suggestedRetrieval',
    ]),
  };

  // nested shell/file refs inside capability output
  if (preview.localToolResultRef && typeof preview.localToolResultRef === 'object') {
    next.localToolResultRef = compactLocalRefPayload(
      { kind: 'local_tool_result_ref', ...preview.localToolResultRef },
      previewChars,
    ) || {
      ...pickDefined(preview.localToolResultRef, [
        'tool',
        'command',
        'cwd',
        'status',
        'exitCode',
        'stdoutPath',
        'stderrPath',
        'metadataPath',
        'artifactRef',
        'artifactRefs',
        'suggestedRetrieval',
      ]),
      microCompacted: true,
    };
  }

  if (typeof preview.preview === 'string') {
    next.preview = previewHistoricalText(preview.preview, previewChars);
  }
  if (typeof preview.stdoutPreview === 'string') {
    next.stdoutPreview = previewHistoricalText(preview.stdoutPreview, previewChars);
  }
  if (typeof preview.stderrPreview === 'string') {
    next.stderrPreview = previewHistoricalText(preview.stderrPreview, Math.min(previewChars, 400));
  }

  // Drop large unstructured blobs that are recoverable via artifact refs.
  if (preview.aggregated && typeof preview.aggregated === 'object') {
    next.aggregated = {
      ...pickDefined(preview.aggregated, ['matchCount', 'truncated', 'laneCount']),
      note: 'Aggregated match details dropped by microcompact; use artifactRefs/suggestedRetrieval.',
    };
  }

  return next;
}

function uniqueNonEmptyStrings(values, limit = 12) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * 从将被裁掉的历史正文中抽取可回捞线索（artifact / path / retrieval command）。
 * 目标：即使原文没有结构化 local_*_ref，压缩后仍留下可再读入口。
 */
function extractRecoverableClues(text, { limit = 12 } = {}) {
  const value = String(text ?? '');
  if (!value) {
    return { artifactRefs: [], paths: [], suggestedRetrieval: [] };
  }

  const artifactRefs = uniqueNonEmptyStrings([
    ...(value.match(/local-[a-z0-9-]+-artifact:\/\/[^\s"'`\]]+/gi) || []),
    ...(value.match(/tool-result:\/\/[^\s"'`\]]+/gi) || []),
    ...(value.match(/goal-plan:\/\/[^\s"'`\]]+/gi) || []),
  ], limit);

  const pathPatterns = [
    /(?:stdoutPath|stderrPath|metadataPath|path)\s*[:=]\s*["']([^"']+)["']/g,
    /(?:^|\s)(\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"'`\]]+)/g,
    /(?:^|\s)([A-Za-z]:\\[^\s"'`\]]+)/g,
  ];
  const paths = [];
  for (const pattern of pathPatterns) {
    for (const match of value.matchAll(pattern)) {
      const candidate = match[1] || match[0];
      if (candidate) paths.push(candidate.trim());
    }
  }

  const retrievalPatterns = [
    /(?:^|\n)\s*((?:rg|tail|sed|cat|head|read_file)\b[^\n]{0,240})/g,
  ];
  const suggestedRetrieval = [];
  for (const pattern of retrievalPatterns) {
    for (const match of value.matchAll(pattern)) {
      const cmd = String(match[1] || '').trim();
      if (cmd.length >= 8) suggestedRetrieval.push(cmd);
    }
  }

  // If we only have artifact paths, synthesize cheap retrieval commands.
  for (const ref of artifactRefs) {
    if (ref.startsWith('local-shell-artifact://') || ref.includes('/stdout')) {
      suggestedRetrieval.push(`tail -n 120 "${ref}"`);
    }
  }
  for (const filePath of uniqueNonEmptyStrings(paths, 6)) {
    if (filePath.includes('stdout') || filePath.endsWith('.txt') || filePath.endsWith('.log')) {
      suggestedRetrieval.push(`tail -n 120 "${filePath}"`);
    } else {
      suggestedRetrieval.push(`sed -n '1,120p' "${filePath}"`);
    }
  }

  return {
    artifactRefs: uniqueNonEmptyStrings(artifactRefs, limit),
    paths: uniqueNonEmptyStrings(paths, limit),
    suggestedRetrieval: uniqueNonEmptyStrings(suggestedRetrieval, limit),
  };
}

function compactLongHistoricalString(text, previewChars) {
  const clues = extractRecoverableClues(text);
  const hasClues = clues.artifactRefs.length > 0
    || clues.paths.length > 0
    || clues.suggestedRetrieval.length > 0;
  const lines = [
    hasClues
      ? '[历史长文本已从活跃上下文压缩为预览；请用下方可回捞线索按需读取原文]'
      : '[历史长文本已从活跃上下文压缩为预览；原文没有可恢复的本地 artifact ref]',
    `originalChars: ${text.length}`,
  ];
  if (clues.artifactRefs.length > 0) {
    lines.push(`artifactRefs: ${JSON.stringify(clues.artifactRefs)}`);
  }
  if (clues.paths.length > 0) {
    lines.push(`paths: ${JSON.stringify(clues.paths)}`);
  }
  if (clues.suggestedRetrieval.length > 0) {
    lines.push('suggestedRetrieval:');
    for (const cmd of clues.suggestedRetrieval) {
      lines.push(`  - ${cmd}`);
    }
  }
  lines.push('', previewHistoricalText(text, previewChars));
  return lines.join('\n');
}

function microcompactStringContent(content, config) {
  const parsed = tryParseJsonObject(content);
  if (parsed) {
    const compactedRef = compactLocalRefPayload(parsed, config.previewChars);
    if (compactedRef) {
      const nextContent = JSON.stringify(compactedRef, null, 2);
      if (nextContent.length < content.length) {
        return {
          content: nextContent,
          compacted: true,
          beforeChars: content.length,
          afterChars: nextContent.length,
        };
      }
    }
  }

  if (content.length <= config.triggerChars) {
    return { content, compacted: false, beforeChars: content.length, afterChars: content.length };
  }

  const nextContent = compactLongHistoricalString(content, config.previewChars);
  return {
    content: nextContent,
    compacted: true,
    beforeChars: content.length,
    afterChars: nextContent.length,
  };
}

function microcompactBlockContent(block, config) {
  if (block?.type === 'tool_result' && typeof block.content === 'string') {
    const result = microcompactStringContent(block.content, config);
    if (result.compacted) {
      return {
        block: { ...block, content: result.content },
        compacted: true,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      };
    }
  }

  if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > config.triggerChars) {
    const result = microcompactStringContent(block.text, config);
    if (result.compacted) {
      return {
        block: { ...block, text: result.content },
        compacted: true,
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      };
    }
  }

  return { block, compacted: false, beforeChars: 0, afterChars: 0 };
}

function microcompactMessageContent(content, config) {
  if (typeof content === 'string') {
    const result = microcompactStringContent(content, config);
    return { content: result.content, compacted: result.compacted, beforeChars: result.beforeChars, afterChars: result.afterChars };
  }

  if (Array.isArray(content)) {
    let compacted = false;
    let beforeChars = 0;
    let afterChars = 0;
    const blocks = content.map((block) => {
      const result = microcompactBlockContent(block, config);
      if (result.compacted) {
        compacted = true;
        beforeChars += result.beforeChars;
        afterChars += result.afterChars;
      }
      return result.block;
    });
    return { content: blocks, compacted, beforeChars, afterChars };
  }

  return { content, compacted: false, beforeChars: 0, afterChars: 0 };
}

export function microcompactMessagesForContext(messages, options = {}) {
  const config = { ...MICROCOMPACTION_CONFIG, ...options };
  let recentNonSystemSeen = 0;
  const compactableIndexes = new Set();

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === 'system' || message?._compaction) continue;
    recentNonSystemSeen++;
    if (recentNonSystemSeen > config.keepRecentCount) {
      compactableIndexes.add(index);
    }
  }

  let compactedCount = 0;
  let beforeChars = 0;
  let afterChars = 0;
  const nextMessages = messages.map((message, index) => {
    if (!compactableIndexes.has(index)) return message;
    const result = microcompactMessageContent(message.content, config);
    if (!result.compacted) return message;
    compactedCount++;
    beforeChars += result.beforeChars;
    afterChars += result.afterChars;
    return {
      ...message,
      content: result.content,
      _microCompaction: {
        method: 'historical_context_preview',
        beforeChars: result.beforeChars,
        afterChars: result.afterChars,
      },
    };
  });

  return {
    messages: compactedCount > 0 ? nextMessages : messages,
    stats: {
      compactedCount,
      beforeChars,
      afterChars,
      savedChars: Math.max(0, beforeChars - afterChars),
    },
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

function splitForCompaction(messages, { preserveLatestUserTurn = false } = {}) {
  const split = splitMessagesForCompaction(messages, { preserveLatestUserTurn });
  return {
    keep: [...split.keepMessages],
    old: [...split.oldMessages],
    systemMsgs: [...split.systemMessages],
  };
}

// ── Format Old Messages for LLM Summary ──

function formatOldMessagesForSummary(messages) {
  return messages
    .map((m) => {
      const content =
        typeof m.content === 'string'
          ? m.content
          : JSON.stringify(m.content);
      return `[${m.role}]: ${content}`;
    })
    .join('\n\n');
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
 * 估算压缩摘要的产出字符数，用作进度条分母。
 *
 * 设计目标：让进度平稳爬升、结尾跳变很小（而不是收尾约 30% 即跳满）。
 * - 基准 = 输入对话字符数 × 压缩比（summaryCompressionRatio）。
 * - 夹逼到 [minEstimatedSummaryChars, maxSummaryChars]，其中 maxSummaryChars
 *   为模型最大输出容量（maxOutputTokens*4），保证不会超过物理上限。
 * - 动态扩张：当真实接收量 receivedChars 已逼近/超过估计值时，把分母抬到
 *   receivedChars 之上（×expandFactor），保证 percent 单调不回退、且在 done
 *   之前不会提前到 100%。
 *
 * @param {object} params
 * @param {number} params.inputChars 摘要输入（旧消息文本）字符数
 * @param {number} params.maxSummaryChars 物理上限 = summaryMaxTokens * charsPerToken
 * @param {number} [params.receivedChars=0] 已流式接收的摘要字符数
 * @returns {number} 估计的摘要总字符数（分母），恒为正整数
 */
function estimateSummaryChars({ inputChars, maxSummaryChars, receivedChars = 0 }) {
  const safeInput = Number.isFinite(inputChars) && inputChars > 0 ? inputChars : 0;
  const minChars = COMPACTION_CONFIG.minEstimatedSummaryChars;
  // 物理上限兜底：异常入参时退回到一个合理的正数上限。
  const upperBound =
    Number.isFinite(maxSummaryChars) && maxSummaryChars > minChars
      ? maxSummaryChars
      : Math.max(minChars, COMPACTION_CONFIG.charsPerToken * 12000);

  // 基准估计：输入 × 压缩比，夹逼到 [min, upperBound]。
  const base = Math.round(safeInput * COMPACTION_CONFIG.summaryCompressionRatio);
  let estimate = Math.min(upperBound, Math.max(minChars, base));

  // 动态扩张：真实产出逼近估计值时，把分母抬到接收量之上，避免提前到满，
  // 同时仍不超过物理上限。expandFactor 留出 ~5% 余量让进度继续平滑爬升：
  // 末段比值 ≈ 1/expandFactor ≈ 95%（而非 1.15 时的 ≈87%），减小收尾跳变。
  if (receivedChars > 0) {
    const expandFactor = 1.05;
    const expanded = Math.ceil(receivedChars * expandFactor);
    estimate = Math.min(upperBound, Math.max(estimate, expanded));
  }

  return Math.max(minChars, estimate);
}

/**
 * 为摘要生成解析输出/输入预算。
 * - 输出：复用模型 maxOutputTokens，并夹在安全范围内
 * - 输入：summaryMaxInputTokens，同时为输出与 safety 预留空间（当 contextWindow 可知时）
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

  let summaryMaxInputTokens = COMPACTION_CONFIG.summaryMaxInputTokens;
  const windowTokens = Number(contextWindow);
  if (Number.isFinite(windowTokens) && windowTokens > 0) {
    // 摘要请求本身也占窗口：给输出与安全区留空，避免 prompt-too-long 在摘要阶段发生。
    const usableInput = Math.max(2_000, windowTokens - summaryMaxTokens - safety);
    summaryMaxInputTokens = Math.min(summaryMaxInputTokens, usableInput);
  }

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
}) {
  const { provider, baseUrl, apiKey, model } = providerConfig;

  // 摘要输出/输入预算：输出对齐模型能力，输入为输出与安全区预留空间。
  const summaryBudget = resolveSummaryTokenBudget(providerConfig, { contextWindow });
  const summaryMaxTokens = summaryBudget.summaryMaxTokens;

  logCompactionDiagnostic('summarize:enter', {
    providerConfig,
    summaryMaxTokens,
    oldMessageCount: Array.isArray(oldMessages) ? oldMessages.length : null,
  });

  const summaryInput = formatOldMessagesForSummary(oldMessages);
  const summaryMessages = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: truncateSummaryInputPreferTail(summaryInput, summaryBudget.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
    { role: 'user', content: COMPACT_PROMPT },
  ];

  // 进度百分比分母：用「对实际摘要产出长度的估计」而非「模型最大输出容量」，
  // 避免进度收尾约 30% 即跳满。物理上限仍为 maxOutputTokens*4。
  const maxSummaryChars = summaryMaxTokens * COMPACTION_CONFIG.charsPerToken;
  const inputChars = summaryInput.length;
  let accumulated = '';
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
        { role: 'user', content: truncateSummaryInputPreferTail(summaryInput, summaryBudget.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
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
    });

    logCompactionDiagnostic('summarize:done', {
      wire: 'anthropic',
      accumulatedChars: accumulated.length,
      empty: accumulated.length === 0,
    });
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
    });

    logCompactionDiagnostic('summarize:done', {
      wire: 'openai-responses',
      accumulatedChars: accumulated.length,
      empty: accumulated.length === 0,
    });
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
  });

  logCompactionDiagnostic('summarize:done', {
    wire: 'openai',
    accumulatedChars: accumulated.length,
    empty: accumulated.length === 0,
  });
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
    }))
    .filter((item) => item.summary.trim() || item.originalMessageCount > 0);
}

function buildContinuityCarryForwardSummary(continuityContext) {
  const items = normalizeContinuityContext(continuityContext);
  if (!items.length) return '';
  // Only carry the latest continuity item, and flatten any prior merge wrappers so
  // repeated compaction cannot nest "## Carry-forward ..." blobs forever.
  const latest = items[items.length - 1];
  const flattened = flattenSummaryForCarryForward(latest.summary)
    || latest.summary.trim()
    || '[previous compacted context summary unavailable]';
  return flattened;
}

function mergeContinuityAndDeltaSummary({ continuityContext, compactSummary, oldCount, decisionAnchors = [] }) {
  const previousSummary = buildContinuityCarryForwardSummary(continuityContext);
  const deltaSummary = flattenSummaryForCarryForward(compactSummary)
    || compactSummary?.trim()
    || `No semantic delta summary was available for the ${oldCount} newly compacted messages.`;
  const decisionSection = formatDecisionAnchorsSection(decisionAnchors);
  let merged;
  if (!previousSummary) {
    merged = deltaSummary;
  } else {
    // One-level merge only: previous body (already flattened) + this delta.
    // Do not store another full nested carry-forward of a prior merge result.
    merged = [
      '## Carry-forward summary from previous compaction',
      previousSummary,
      '',
      `## Delta summary since previous compaction (${oldCount} messages)`,
      deltaSummary,
    ].join('\n');
  }
  // Persist decision anchors inside the stored summary so later continuity carry-forward
  // still retains them even after the original messages leave the active window.
  if (decisionSection) {
    return `${decisionSection}\n\n${merged}`;
  }
  return merged;
}

function countContinuityMessages(continuityContext) {
  return normalizeContinuityContext(continuityContext)
    .reduce((sum, item) => sum + Math.max(0, item.originalMessageCount || 0), 0);
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
}) {
  const result = [{ role: 'system', content: systemPrompt }];
  const previousMessageCount = countContinuityMessages(continuityContext);
  const representedMessageCount = previousMessageCount + oldCount;
  const anchors = Array.isArray(decisionAnchors) ? decisionAnchors : [];
  const mergedSummary = mergeContinuityAndDeltaSummary({
    continuityContext,
    compactSummary,
    oldCount,
    decisionAnchors: anchors,
  });

  result.push({
    role: 'user',
    content: buildHandoffContent({
      compactSummary: mergedSummary,
      oldCount: representedMessageCount,
      // Anchors already embedded in mergedSummary for continuity persistence;
      // still pass explicitly so handoff rendering stays robust if summary is empty.
      decisionAnchors: anchors,
    }),
    _compaction: {
      method,
      fallbackReason: fallbackReason || undefined,
      fallbackDetail: fallbackDetail || undefined,
      originalMessageCount: representedMessageCount,
      deltaMessageCount: oldCount,
      previousMessageCount,
      beforeTokens,
      afterTokens,
      // Store merged summary (with decision anchors) for subsequent continuity carry-forward.
      summary: mergedSummary || '',
      decisionAnchors: anchors,
    },
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

// ── PTL Truncation ──

function truncateHeadForRetry(messages) {
  const groups = groupMessagesByApiRound(messages);
  if (groups.length < 2) return null;

  // Drop the oldest group
  const dropCount = Math.max(1, Math.floor(groups.length * 0.2));
  const keep = groups.slice(dropCount).flat();

  // Ensure first message is not assistant
  if (keep.length > 0 && keep[0].role === 'assistant') {
    return [
      { role: 'user', content: '[earlier conversation truncated]' },
      ...keep,
    ];
  }
  return keep.length > 0 ? keep : null;
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
  // 可选：provider 真实 usage（input + cacheRead）。ADR 52：仅诊断，不参与 Layer2 触发。
  // 触发只看下一请求投影估算（messages + tools schema）。
  usageTokens = null,
}) {
  const microcompactResult = microcompactMessagesForContext(messages);
  messages = microcompactResult.messages;
  const previousMessageCount = countContinuityMessages(continuityContext);
  const breakerScope = conversationId || streamId || null;

  // Circuit breaker: stop trying if we've failed too many times
  if (isCircuitBreakerTripped(breakerScope)) {
    // Still do basic structural compaction + drop as last resort
    const { keep, old } = splitForCompaction(messages, { preserveLatestUserTurn });
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
  const estimatedLocal = estimateTokensFromMessages(messages) + estimateToolsTokens(tools);
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
  const { keep, old } = splitForCompaction(messages, { preserveLatestUserTurn });
  if (old.length === 0) {
    return { compacted: false, messages };
  }

  console.log(
    `[context-compactor] Compacting: est ${estimated} / ${contextWindow || 'unknown'} tokens, ${old.length} old messages → ${keep.length} kept${force ? ' (force)' : ''}`,
  );

  const beforeTokens = estimated;
  let compactSummary = null;
  let method = 'structural';
  // 记录"为什么没走 LLM / LLM 为什么失败"，让兜底原因在 Evidence 与 UI 可见。
  let fallbackReason = providerConfig ? null : 'no_provider';
  let fallbackDetail = providerConfig ? null : 'No LLM provider configured for summarization';

  // Tier 1: Try LLM semantic summary
  if (providerConfig) {
    try {
      for (let attempt = 1; attempt <= COMPACTION_CONFIG.maxPtlRetries; attempt++) {
        try {
          const rawSummary = await summarizeWithLLM({
            oldMessages: old,
            providerConfig,
            signal,
            onProgress,
            webContents,
            streamId,
            connectionRecoveryOptions,
            contextWindow,
          });

          if (rawSummary) {
            compactSummary = formatCompactSummary(rawSummary);
            method = 'llm';
            console.log(
              `[context-compactor] LLM summary success (${compactSummary.length} chars)`,
            );
            recordCompactionSuccess(breakerScope);
          }
          break; // success, exit retry loop
        } catch (err) {
          const errMsg = err?.message || '';
          const isPromptTooLong =
            errMsg.includes('prompt_too_long') ||
            errMsg.includes('context_length_exceeded') ||
            errMsg.includes('413') ||
            errMsg.includes('400') ||
            errMsg.includes('token');

          logCompactionDiagnostic('compact:attempt_error', {
            attempt,
            maxPtlRetries: COMPACTION_CONFIG.maxPtlRetries,
            oldMessageCount: old.length,
            isPromptTooLong,
            errorName: err?.name ?? null,
            errorMessage: errMsg.slice(0, 1000),
            errorCode: err?.code ?? err?.cause?.code ?? null,
          });

          if (isPromptTooLong && attempt < COMPACTION_CONFIG.maxPtlRetries) {
            // PTL retry: truncate head
            const truncated = truncateHeadForRetry(old);
            if (truncated) {
              console.warn(
                `[context-compactor] PTL retry ${attempt}/${COMPACTION_CONFIG.maxPtlRetries}: ${old.length} → ${truncated.length} messages`,
              );
              old.splice(0, old.length, ...truncated);
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
      logCompactionDiagnostic('compact:fallback', {
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

  // Build result
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
  });

  let afterTokens = estimateTokensFromMessages(result);
  setCompactionAfterTokens(result, afterTokens);

  // 压缩不是“生成了摘要”就算成功：自动压缩必须同时满足两条验收条件：
  // 1) messages + tools 的总预算确实下降；2) 回到触发线以内。
  // 结构摘要在大量短消息场景可能比原文还大，LLM 也可能返回异常冗长摘要；此时降级为
  // 最小 handoff。若连最小 handoff + 必须保留的 user/tool 尾都无法过线，则明确失败，
  // 避免把“压后仍超窗”伪装成 compacted:true 后继续撞 provider。
  const toolTokens = estimateToolsTokens(tools);
  const triggerLimit = contextWindow
    ? Math.floor(contextWindow * COMPACTION_CONFIG.triggerRatio)
    : null;
  let afterBudgetTokens = afterTokens + toolTokens;
  const requiresBudgetAcceptance = shouldCompact(beforeTokens, contextWindow);
  const meetsBudgetAcceptance = () => (
    afterBudgetTokens < beforeTokens
    && (triggerLimit === null || afterBudgetTokens <= triggerLimit)
  );

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
    for (const alternative of alternatives) {
      const candidate = buildCompactedMessages({
        systemPrompt,
        compactSummary: alternative.summary,
        oldCount: old.length,
        keepMessages: keep,
        method: alternative.method,
        beforeTokens,
        afterTokens: 0,
        continuityContext,
        fallbackReason: 'insufficient_reduction',
        fallbackDetail: `${rejectedMethod} candidate left ${rejectedBudgetTokens} tokens against trigger ${triggerLimit}`,
        decisionAnchors,
      });
      const candidateAfterTokens = estimateTokensFromMessages(candidate);
      setCompactionAfterTokens(candidate, candidateAfterTokens);
      const candidateBudgetTokens = candidateAfterTokens + toolTokens;
      minimalCandidateBudgetTokens = Math.min(minimalCandidateBudgetTokens, candidateBudgetTokens);
      if (
        candidateBudgetTokens < beforeTokens
        && (triggerLimit === null || candidateBudgetTokens <= triggerLimit)
      ) {
        result = candidate;
        compactSummary = alternative.summary;
        method = alternative.method;
        fallbackReason = 'insufficient_reduction';
        fallbackDetail = `${rejectedMethod} candidate left ${rejectedBudgetTokens} tokens against trigger ${triggerLimit}`;
        afterTokens = candidateAfterTokens;
        afterBudgetTokens = candidateBudgetTokens;
        accepted = true;
        break;
      }
    }

    if (!accepted) {
      const error = new Error(
        `Context compaction could not reduce the prompt below ${triggerLimit} tokens; minimal candidate=${minimalCandidateBudgetTokens}, before=${beforeTokens}`,
      );
      error.code = 'CONTEXT_COMPACTION_INSUFFICIENT_REDUCTION';
      logCompactionDiagnostic('compact:insufficient_reduction', {
        beforeTokens,
        afterBudgetTokens: minimalCandidateBudgetTokens,
        triggerLimit,
        oldMessageCount: old.length,
        keptMessageCount: keep.length,
      });
      throw error;
    }
  }

  console.log(
    `[context-compactor] Compaction complete: ${beforeTokens} → ${afterBudgetTokens} tokens (method: ${method})`,
  );

  logCompactionDiagnostic('compact:complete', {
    method,
    fallbackReason,
    beforeTokens,
    afterTokens,
    afterBudgetTokens,
    triggerLimit,
    oldMessageCount: old.length,
    summaryChars: typeof compactSummary === 'string' ? compactSummary.length : 0,
  });

  return {
    compacted: true,
    messages: result,
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
  resolveSummaryTokenBudget,
  truncateSummaryInputPreferTail,
  flattenSummaryForCarryForward,
  extractRecentDecisionAnchors,
  mergeContinuityAndDeltaSummary,
  buildHandoffContent,
};
