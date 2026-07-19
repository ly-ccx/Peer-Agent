/**
 * Context Compactor — 对标 Claude Code 的三层压缩体系
 *
 * Layer 1: 每轮 token 检查 (compactIfNeeded)
 * Layer 2: LLM 语义压缩 (summarizeWithLLM) → 结构摘要 fallback → 直接丢弃
 * Layer 3: 手动 /compact 指令（通过 chat:compact IPC handler）
 */

import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';
import { encodeOpenAIResponsesRequest } from './provider-encoders/responses-encoder.mjs';
import { fetchWithConnectionRecovery } from './provider-transports/recovering-fetch.mjs';
import { logCompactionDiagnostic } from './compaction-diagnostic-log.mjs';
import { neutralizeToolCallSyntax } from './chat-runtime/message-sanitizer.mjs';

const COMPACTION_CONFIG = {
  triggerRatio: 0.8,
  charsPerToken: 4,
  // 中文/日文/韩文等 CJK 字符的分词密度远高于英文：英文约 4 字符/token，
  // CJK 约 1.7 字符/token（实测一段中文按 /4 会被低估约 2 倍）。两段分别估算，
  // 避免把大量中文按 /4 系统性腰斩，导致进度条远低于 provider 实际计入的 input tokens。
  cjkCharsPerToken: 1.7,
  // 图片/文档块的固定 token 近似开销。
  imageTokens: 2000,
  // 每条消息的框架开销（role / 分隔符等结构性 token），对标 provider 计费口径。
  // 旧实现按「+10 字符 / 4」≈ 2.5 token，偏小，这里直接以 token 计 4。
  messageFramingTokens: 4,
  // 每个 tool_use / tool_result 块除正文外的固定结构开销（块头、id、type 等）。
  toolCallBlockOverhead: 8,
  // 每个工具 schema 定义除 JSON 文本外的固定开销（名称包装、分隔等）。
  toolDefinitionOverhead: 16,
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
};

const MICROCOMPACTION_CONFIG = {
  keepRecentCount: 8,
  triggerChars: 6_000,
  previewChars: 800,
};

// 摘要专用 system prompt（对标 CC AGENT_CONTEXT_SUMMARY_SYSTEM_PROMPT）
const SUMMARY_SYSTEM_PROMPT =
  '你是对话摘要专家。请将以下对话历史压缩为详细摘要，保留关键信息：用户意图、重要决策、技术概念、文件变更、错误修复、待办事项。特别要详细记录用户的具体执行动作与操作步骤——用户要求做了什么、实际改动了哪些文件、命令/操作执行到哪一步、当前停在何处——因为原文已全量压缩、不再保留，连续性完全依赖本摘要承载。输出纯文本，不要用 markdown。';

// 9 章节 compaction prompt（对标 CC BASE_COMPACT_PROMPT）
const COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts. In your analysis:
1. Chronologically analyze each message and section of the conversation. For each section identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, code snippets, function signatures
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request. CRITICAL — record the user's concrete execution actions and operation steps in detail: what the user asked to do, which files were actually changed, what commands/operations were run and to which step they progressed, and exactly where things currently stand. The original conversation is fully compacted and NOT retained, so continuity depends entirely on this summary capturing those execution details.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name]
      - [Summary of why this file is important]
      - [Code Snippet if applicable]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]
      - [User feedback on the error if any]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages:
    - [Non-tool-use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response.`;

// ── Circuit breaker state (module-level, per session) ──

let consecutiveCompactionFailures = 0;

export function resetCircuitBreaker() {
  consecutiveCompactionFailures = 0;
}

function isCircuitBreakerTripped() {
  return consecutiveCompactionFailures >= COMPACTION_CONFIG.circuitBreakerThreshold;
}

function recordCompactionSuccess() {
  consecutiveCompactionFailures = 0;
}

function recordCompactionFailure() {
  consecutiveCompactionFailures++;
  if (isCircuitBreakerTripped()) {
    console.warn(
      `[context-compactor] Circuit breaker tripped after ${consecutiveCompactionFailures} consecutive failures — skipping future compaction attempts this session`,
    );
  }
}

// ── Token Estimation （对标 CC roughTokenCountEstimationForMessages）──

// CJK 字符范围（中日韩统一表意文字、扩展 A、兼容表意、假名、谚文、全角标点）。
// 命中这些字符的部分按 cjkCharsPerToken 估，其余按 charsPerToken 估，
// 避免中文被「/4」系统性低估约 2 倍。
const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/g;

/**
 * CJK 感知的文本 token 估算：CJK 字符按更高权重（约 1.7 字符/token），
 * 其余字符按英文权重（约 4 字符/token）。返回 token 数（未取整，便于累加）。
 */
function estimateTextTokens(text) {
  if (!text) return 0;
  const str = typeof text === 'string' ? text : String(text);
  const cjkMatches = str.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = str.length - cjkCount;
  return (
    cjkCount / COMPACTION_CONFIG.cjkCharsPerToken +
    otherCount / COMPACTION_CONFIG.charsPerToken
  );
}

function estimateTokensFromMessages(messages) {
  let tokens = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      tokens += estimateTextTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text' && block.text) {
          tokens += estimateTextTokens(block.text);
        } else if (block.type === 'tool_use') {
          tokens += estimateTextTokens(block.name || '');
          tokens += estimateTextTokens(JSON.stringify(block.input || {}));
          tokens += COMPACTION_CONFIG.toolCallBlockOverhead;
        } else if (block.type === 'tool_result') {
          tokens += estimateTextTokens(
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content ?? ''),
          );
          tokens += COMPACTION_CONFIG.toolCallBlockOverhead;
        } else if (
          block.type === 'image' ||
          block.type === 'image_url' ||
          block.type === 'input_image' ||
          block.type === 'document'
        ) {
          // 图片/文档以固定开销计。注意：未归一化前图片块的 type 可能是 'image_url'
          // （renderer apiMessageMapping）或 'input_image'（OpenAI responses），其内部
          // 携带的 base64 data URL 极大；若漏判会被 JSON.stringify 整段计入，导致几 MB
          // 的图片被估成上百万 token，进而每轮都误触发压缩。
          tokens += COMPACTION_CONFIG.imageTokens; // fixed image tokens
        } else {
          tokens += estimateTextTokens(JSON.stringify(block));
        }
      }
    }
    tokens += COMPACTION_CONFIG.messageFramingTokens; // 每条消息框架开销
  }
  return Math.ceil(tokens);
}

/**
 * 估算工具 schema 在每次请求里占用的 token。
 *
 * 工具定义（名称 + 描述 + JSON Schema 参数）是每次请求都全量发送给 provider 的，
 * 但旧实现的进度条/压缩触发完全没算它们。47 个工具的 schema 实测可达上万 token，
 * 是「进度条只有 ~100k 但 provider 报 input exceeds context window」的最大缺口。
 *
 * 兼容多种工具结构：
 * - Anthropic: { name, description, input_schema }
 * - OpenAI chat: { type:'function', function:{ name, description, parameters } }
 * - OpenAI responses / 扁平: { name, description, parameters }
 * - Gemini: { functionDeclarations: [{ name, description, parameters }] }
 *
 * @param {Array|object} tools 工具定义列表（或包含 functionDeclarations 的对象）
 * @returns {number} 估算 token 数
 */
function estimateToolsTokens(tools) {
  if (!tools) return 0;
  // Gemini 形态：{ functionDeclarations: [...] } 或其数组
  let list = tools;
  if (!Array.isArray(list)) {
    if (Array.isArray(tools.functionDeclarations)) {
      list = tools.functionDeclarations;
    } else {
      list = [tools];
    }
  }
  let tokens = 0;
  for (const tool of list) {
    if (!tool || typeof tool !== 'object') continue;
    if (Array.isArray(tool.functionDeclarations)) {
      tokens += estimateToolsTokens(tool.functionDeclarations);
      continue;
    }
    const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
    const name = fn.name || tool.name || '';
    const description = fn.description || tool.description || '';
    const schema =
      fn.parameters ?? fn.input_schema ?? tool.parameters ?? tool.input_schema ?? {};
    tokens += estimateTextTokens(name);
    tokens += estimateTextTokens(description);
    tokens += estimateTextTokens(JSON.stringify(schema ?? {}));
    tokens += COMPACTION_CONFIG.toolDefinitionOverhead;
  }
  return Math.ceil(tokens);
}

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
      compacted.stderrPreview = previewHistoricalText(payload.stderrPreview, previewChars);
    }
    return compacted;
  }

  if (payload?.kind === 'local_file_ref') {
    const compacted = {
      kind: payload.kind,
      microCompacted: true,
      note: 'Historical local file read compacted; use path or suggestedRetrieval for full content.',
      ...pickDefined(payload, [
        'tool',
        'path',
        'chars',
        'lines',
        'contextPreviewTruncated',
        'suggestedRetrieval',
      ]),
    };
    if (payload.preview) {
      compacted.preview = previewHistoricalText(payload.preview, previewChars);
    }
    return compacted;
  }

  return null;
}

function compactLongHistoricalString(text, previewChars) {
  return [
    '[历史长文本已从活跃上下文压缩为预览；原文没有可恢复的本地 artifact ref]',
    `originalChars: ${text.length}`,
    '',
    previewHistoricalText(text, previewChars),
  ].join('\n');
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
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const convMsgs = messages.filter((m) => m.role !== 'system');

  // 默认保持手动 /compact 的“真·全量压缩”：旧消息全部摘要，连当前轮原文也不保留。
  // 自动 preflight 压缩则必须保留最新真人 user turn：用户刚发送的原文不能被 summary 代替。
  const currentTurnStart = preserveLatestUserTurn ? findCurrentTurnStart(convMsgs) : -1;
  let initialKeep;
  let initialOld;
  if (currentTurnStart >= 0) {
    const latestUser = convMsgs[currentTurnStart];
    const currentTurnTail = convMsgs.slice(currentTurnStart + 1);
    const unclosedTailStart = findUnclosedToolTailStart(currentTurnTail);
    initialKeep = [latestUser, ...currentTurnTail.slice(unclosedTailStart)];
    initialOld = [
      ...convMsgs.slice(0, currentTurnStart),
      ...currentTurnTail.slice(0, unclosedTailStart),
    ];
  } else {
    // ⚠️ 全量压缩时显式把 keep 设为空：slice(-0) ≡ slice(0) 会把切分反转。
    initialKeep = [];
    initialOld = convMsgs;
  }

  // 异常 provider 历史若让 keep 从 tool_result 开始，兜底把对应 tool_use 一并拉入，
  // 避免发送孤立工具结果。
  const split = expandKeepForToolContinuity({ keep: initialKeep, old: initialOld });
  return {
    keep: split.keep,
    old: split.old,
    systemMsgs,
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

  // Clean up extra whitespace
  formatted = formatted.replace(/\n\n\n+/g, '\n\n');

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

async function summarizeWithLLM({
  oldMessages,
  providerConfig,
  signal,
  onProgress,
  webContents = null,
  streamId = null,
  connectionRecoveryOptions = {},
}) {
  const { provider, baseUrl, apiKey, model } = providerConfig;

  // 摘要输出上限复用「当前模型的 maxOutputTokens」，让压缩与模型真实能力对齐，
  // 避免写死的小上限把长摘要截断（表现为压缩后内容看不全）。未配置时回退到 12000。
  const summaryMaxTokens = providerConfig.maxOutputTokens || 12000;

  logCompactionDiagnostic('summarize:enter', {
    providerConfig,
    summaryMaxTokens,
    oldMessageCount: Array.isArray(oldMessages) ? oldMessages.length : null,
  });

  const summaryInput = formatOldMessagesForSummary(oldMessages);
  const summaryMessages = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: summaryInput.slice(0, COMPACTION_CONFIG.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
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
        { role: 'user', content: summaryInput.slice(0, COMPACTION_CONFIG.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
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

function buildHandoffContent({ compactSummary, oldCount }) {
  const summary = compactSummary?.trim()
    || 'Earlier conversation was removed from the active prompt because compaction summary generation was unavailable. Continue from the recent messages and ask for clarification if required.';

  return [
    `[上下文交接 - 共压缩 ${oldCount} 条消息]`,
    '',
    '以下是之前工作进展的压缩交接。请基于这份交接和后续保留的最近消息继续任务，不要重复已经完成的工作。',
    '',
    '## 已完成的工作与关键上下文',
    summary,
    '',
    '## 继续执行要求',
    '- 优先承接用户最近的明确要求。',
    '- 如果交接摘要和最近消息冲突，以最近消息为准。',
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
  return items
    .map((item, index) => [
      `### Previous compacted context ${index + 1}`,
      `id: ${item.id}`,
      `method: ${item.method}`,
      `representedMessages: ${item.originalMessageCount}`,
      item.summary.trim() || '[previous compacted context summary unavailable]',
    ].join('\n'))
    .join('\n\n');
}

function mergeContinuityAndDeltaSummary({ continuityContext, compactSummary, oldCount }) {
  const previousSummary = buildContinuityCarryForwardSummary(continuityContext);
  const deltaSummary = compactSummary?.trim()
    || `No semantic delta summary was available for the ${oldCount} newly compacted messages.`;
  if (!previousSummary) return deltaSummary;
  return [
    '## Carry-forward summary from previous compaction',
    previousSummary,
    '',
    `## Delta summary since previous compaction (${oldCount} messages)`,
    deltaSummary,
  ].join('\n');
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
}) {
  const result = [{ role: 'system', content: systemPrompt }];
  const previousMessageCount = countContinuityMessages(continuityContext);
  const representedMessageCount = previousMessageCount + oldCount;
  const mergedSummary = mergeContinuityAndDeltaSummary({
    continuityContext,
    compactSummary,
    oldCount,
  });

  result.push({
    role: 'user',
    content: buildHandoffContent({ compactSummary: mergedSummary, oldCount: representedMessageCount }),
    _compaction: {
      method,
      fallbackReason: fallbackReason || undefined,
      fallbackDetail: fallbackDetail || undefined,
      originalMessageCount: representedMessageCount,
      deltaMessageCount: oldCount,
      previousMessageCount,
      beforeTokens,
      afterTokens,
      summary: mergedSummary || '',
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
  connectionRecoveryOptions = {},
  tools = null,
  preserveLatestUserTurn = false,
  // 可选：provider 真实 usage（input + cacheRead）。有值时触发阈值取 max(本地估算, usage)，
  // 与进度条 / coordinator 预算口径对齐，避免「条已满但本地低估仍不压」。
  usageTokens = null,
}) {
  const microcompactResult = microcompactMessagesForContext(messages);
  messages = microcompactResult.messages;
  const previousMessageCount = countContinuityMessages(continuityContext);

  // Circuit breaker: stop trying if we've failed too many times
  if (isCircuitBreakerTripped()) {
    // Still do basic structural compaction + drop as last resort
    const { keep, old } = splitForCompaction(messages, { preserveLatestUserTurn });
    if (old.length === 0) return { compacted: false, messages };

    const beforeTokens = estimateTokensFromMessages(messages);
    // Emergency: just keep recent messages
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
  // 若有 provider 真实 usage 高水位，取 max(本地估算, usage)，与进度条 soft 线对齐。
  const estimatedLocal = estimateTokensFromMessages(messages) + estimateToolsTokens(tools);
  const usageNum = Number.isFinite(usageTokens) && usageTokens > 0 ? usageTokens : null;
  const estimated = usageNum != null ? Math.max(estimatedLocal, usageNum) : estimatedLocal;

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
          });

          if (rawSummary) {
            compactSummary = formatCompactSummary(rawSummary);
            method = 'llm';
            console.log(
              `[context-compactor] LLM summary success (${compactSummary.length} chars)`,
            );
            recordCompactionSuccess();
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
      recordCompactionFailure();
    }
  }

  // Tier 2: Structural summary fallback
  if (!compactSummary) {
    compactSummary = summarizeOldMessages(old);
    method = compactSummary ? 'structural' : 'fallback_drop';
    if (!fallbackReason) {
      // providerConfig 存在但 compactSummary 为空且未进 catch（理论兜底），标注未知。
      fallbackReason = providerConfig ? 'llm_unavailable' : fallbackReason;
    }
  }

  // Build result
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
};
