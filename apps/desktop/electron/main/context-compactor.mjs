/**
 * Context Compactor — 对标 Claude Code 的三层压缩体系
 *
 * Layer 1: 每轮 token 检查 (compactIfNeeded)
 * Layer 2: LLM 语义压缩 (summarizeWithLLM) → 结构摘要 fallback → 直接丢弃
 * Layer 3: 手动 /compact 指令（通过 chat:compact IPC handler）
 */

import { buildClaudeCliIdentityHeaders } from './provider-adapters/anthropic-cli-identity.mjs';

const COMPACTION_CONFIG = {
  triggerRatio: 0.8,
  targetRatio: 0.5,
  keepRecentCount: 10,
  charsPerToken: 4,
  summaryMaxTokens: 4000,
  summaryMaxInputTokens: 80_000,   // 摘要输入的上限（旧消息文本）
  summaryTemperature: 0.2,
  maxPtlRetries: 3,
  circuitBreakerThreshold: 3,
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

function estimateTokensFromMessages(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text' && block.text) {
          chars += block.text.length;
        } else if (block.type === 'tool_use') {
          chars += (block.name || '').length;
          chars += JSON.stringify(block.input || {}).length;
        } else if (block.type === 'tool_result') {
          chars +=
            typeof block.content === 'string'
              ? block.content.length
              : JSON.stringify(block.content ?? '').length;
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
          chars += 2000 * COMPACTION_CONFIG.charsPerToken; // fixed 2000 tokens
        } else {
          chars += JSON.stringify(block).length;
        }
      }
    }
    chars += 10; // message overhead
  }
  return Math.ceil(chars / COMPACTION_CONFIG.charsPerToken);
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

// 定位「当前轮」起点：最后一个 user 消息的下标。
// 真·全量压缩下（见 真·全量压缩设计），切分本身不再依赖此函数选取 keep；
// 仅保留以兜底回溯/可读性，并供 shouldRunCompaction 的 force 分支判断「是否有可摘要的消息」。
// 返回 -1 表示无 user 消息（异常路径，由调用方回退处理）。
function findCurrentTurnStart(convMsgs) {
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    if (convMsgs[i]?.role === 'user') return i;
  }
  return -1;
}

function splitForCompaction(messages) {
  const systemMsgs = messages.filter((m) => m.role === 'system');
  const convMsgs = messages.filter((m) => m.role !== 'system');

  // 真·全量压缩（见 真·全量压缩设计）：旧消息全部摘要，连当前轮原文也不保留。
  // cutIndex = convMsgs.length → keep = slice(len) = []、old = slice(0, len) = 全部。
  // ⚠️ 显式用 length 而非负数：slice(-0) ≡ slice(0) = 全部，会把切分反转、压缩失效。
  //    用 length 切分恒为「keep 空 / old 全部」，无 slice(-0) 歧义。
  const cutIndex = convMsgs.length;

  // 唯一保留：末尾若是悬空工具对（assistant tool_call 尚未闭合 / keep 首条为孤立
  // tool_result），由 expandKeepForToolContinuity 兜底拉入最小未闭合工具尾，
  // 避免下一轮 provider 因 tool_call/tool_result 配对缺失报错。这是协议正确性兜底，
  // 非「保留对话」；正常路径 keep 为空、keptMessageCount=0。
  const split = expandKeepForToolContinuity({
    keep: convMsgs.slice(cutIndex),
    old: convMsgs.slice(0, cutIndex),
  });
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
  let formatted = summary;

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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
}

async function summarizeWithLLM({
  oldMessages,
  providerConfig,
  signal,
  onProgress,
}) {
  const { provider, baseUrl, apiKey, model } = providerConfig;

  const summaryInput = formatOldMessagesForSummary(oldMessages);
  const summaryMessages = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: summaryInput.slice(0, COMPACTION_CONFIG.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
    { role: 'user', content: COMPACT_PROMPT },
  ];

  // 预期摘要总长（按 token 上限估算），用于进度百分比分母。
  const estimatedTotalChars =
    COMPACTION_CONFIG.summaryMaxTokens * COMPACTION_CONFIG.charsPerToken;
  let accumulated = '';
  const reportProgress = () => {
    if (typeof onProgress !== 'function') return;
    try {
      onProgress({ receivedChars: accumulated.length, estimatedTotalChars });
    } catch {
      // 进度回调不应影响主流程
    }
  };

  if (provider === 'anthropic') {
    // Anthropic: 流式，按 content_block_delta 累加文本并上报进度。
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
    const body = {
      model,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: summaryInput.slice(0, COMPACTION_CONFIG.summaryMaxInputTokens * COMPACTION_CONFIG.charsPerToken) },
        { role: 'user', content: COMPACT_PROMPT },
      ],
      max_tokens: COMPACTION_CONFIG.summaryMaxTokens,
      // 注意：当前 Anthropic 模型（Vertex 上的 Claude）已弃用 temperature，
      // 传入会返回 400 invalid_request_error。与对话主路径对齐：不传 temperature。
      stream: true,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        ...buildClaudeCliIdentityHeaders(),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
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

    return accumulated || null;
  }

  // OpenAI: 流式，按 choices[].delta.content 累加文本并上报进度。
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages: summaryMessages,
    max_completion_tokens: COMPACTION_CONFIG.summaryMaxTokens,
    temperature: COMPACTION_CONFIG.summaryTemperature,
    stream: true,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
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

  return accumulated || null;
}

// ── Improved Structural Summary（Fallback Tier 1）──

function summarizeOldMessages(oldMessages) {
  const parts = [];

  // Group by turn: each assistant message + preceding user message = one turn
  let turnCounter = 0;
  let currentUser = null;

  for (const m of oldMessages) {
    if (m.role === 'user') {
      currentUser = m;
    } else if (m.role === 'assistant' && currentUser) {
      turnCounter++;
      const userContent =
        typeof currentUser.content === 'string'
          ? currentUser.content
          : JSON.stringify(currentUser.content);

      parts.push(`\n### Turn ${turnCounter}`);
      parts.push(
        `**User**: ${userContent.slice(0, 800)}${userContent.length > 800 ? '...' : ''}`,
      );

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

// ── Verify Compact Result ──

function verifyCompactResult(messages, contextWindow) {
  const afterTokens = estimateTokensFromMessages(messages);
  if (!contextWindow) return { afterTokens, belowTarget: true, target: 0 };
  const target = contextWindow * COMPACTION_CONFIG.targetRatio;

  return {
    afterTokens,
    belowTarget: afterTokens <= target,
    target,
  };
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
}) {
  const microcompactResult = microcompactMessagesForContext(messages);
  messages = microcompactResult.messages;
  const previousMessageCount = countContinuityMessages(continuityContext);

  // Circuit breaker: stop trying if we've failed too many times
  if (isCircuitBreakerTripped()) {
    // Still do basic structural compaction + drop as last resort
    const { keep, old } = splitForCompaction(messages);
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

  // Estimate current tokens
  const estimated = estimateTokensFromMessages(messages);

  if (!shouldRunCompaction({ force, estimatedTokens: estimated, contextWindow, messages })) {
    return { compacted: false, messages };
  }

  // Split
  const { keep, old } = splitForCompaction(messages);
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
  const result = buildCompactedMessages({
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

  const afterTokens = estimateTokensFromMessages(result);
  setCompactionAfterTokens(result, afterTokens);

  // Verify: if still over target, trim more aggressively
  const verification = verifyCompactResult(result, contextWindow);
  if (!verification.belowTarget) {
    console.warn(
      `[context-compactor] Post-compact ${afterTokens} tokens still above target ${verification.target} — trimming keep to 5`,
    );
    // Override keep with even fewer messages
    const trimmedResult = buildCompactedMessages({
      systemPrompt,
      compactSummary,
      oldCount: old.length + Math.max(0, keep.length - 5),
      keepMessages: keep.slice(-5),
      method,
      beforeTokens,
      afterTokens: estimateTokensFromMessages([
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: buildHandoffContent({ compactSummary, oldCount: old.length }),
        },
        ...keep.slice(-5),
      ]),
      continuityContext,
      fallbackReason,
      fallbackDetail,
    });
    const trimmedAfterTokens = estimateTokensFromMessages(trimmedResult);
    setCompactionAfterTokens(trimmedResult, trimmedAfterTokens);

    return {
      compacted: true,
      messages: trimmedResult,
      notification: {
        method,
        fallbackReason,
        fallbackDetail,
        beforeTokens,
        afterTokens: trimmedAfterTokens,
        oldMessageCount: old.length + Math.max(0, keep.length - 5),
        previousMessageCount,
        totalMessageCount: previousMessageCount + old.length + Math.max(0, keep.length - 5),
        keptMessageCount: Math.min(5, keep.length),
      },
    };
  }

  console.log(
    `[context-compactor] Compaction complete: ${beforeTokens} → ${afterTokens} tokens (method: ${method})`,
  );

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

export { COMPACTION_CONFIG, estimateTokensFromMessages, formatCompactSummary };
