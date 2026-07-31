import crypto from 'node:crypto';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { consumeOpenAIStream } from './openai-chat-adapter.mjs';
import {
  getQoderModelMetadata,
  resolveQoderModelOptionProjection,
} from './qoder-model-catalog.mjs';
import { prepareQoderInferRequest, resolveQoderInferenceEndpoint } from './qoder-local-auth.mjs';


/** Qoder slow-queue (10605) and transient stream failures. */
export const QODER_QUEUE_MAX_RETRIES = 3;
export const QODER_QUEUE_MAX_WAIT_MS = 120_000;
export const QODER_QUEUE_DEFAULT_WAIT_MS = 15_000;
/** When upstream waitTime is huge, still keep each client wait bounded. */
export const QODER_QUEUE_LONG_WAIT_HINT_MS = 5 * 60_000;
/** 103 Duplicate + rate-limit style stream failures: short bounded backoff. */
export const QODER_TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
export const QODER_CONNECTION_RETRY_DELAYS_MS = [1_000, 3_000];

function sleepMs(ms, signal) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error('Aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function tryParseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObjectsFromText(text) {
  const raw = String(text || '');
  const objects = [];
  const direct = tryParseJsonObject(raw);
  if (direct) objects.push(direct);
  // Greedy-ish scan for nested JSON objects embedded in provider_stream_error text.
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < raw.length; j += 1) {
      if (raw[j] === '{') depth += 1;
      else if (raw[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = tryParseJsonObject(raw.slice(i, j + 1));
          if (candidate) objects.push(candidate);
          i = j;
          break;
        }
      }
    }
  }
  return objects;
}

function normalizeQueuePayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const nestedMessage = payload.message && typeof payload.message === 'object' ? payload.message : null;
  const source = nestedMessage || payload;
  const code = String(payload.code ?? nestedMessage?.code ?? payload.type ?? '');
  const isQueued = source.isQueued === true
    || source.queued === true
    || code === '10605'
    || /isQueued["']?\s*:\s*true/i.test(JSON.stringify(payload));
  if (!isQueued && code !== '10605') return null;
  const waitTimeRaw = source.waitTime ?? source.wait_time ?? source.estimatedWaitMs ?? nestedMessage?.waitTime;
  const waitTimeMs = Number(waitTimeRaw);
  const serviceAvailableRaw = source.serviceAvailable ?? source.service_available
    ?? nestedMessage?.serviceAvailable ?? payload.serviceAvailable;
  const serviceAvailable = typeof serviceAvailableRaw === 'boolean' ? serviceAvailableRaw : null;
  return {
    kind: 'queued',
    code: code || '10605',
    queueType: source.queueType || source.queue_type || null,
    waitTimeMs: Number.isFinite(waitTimeMs) && waitTimeMs > 0 ? waitTimeMs : QODER_QUEUE_DEFAULT_WAIT_MS,
    queueCount: Number(source.queueCount ?? source.queue_count) || null,
    serviceAvailable,
    reason: 'queue',
    raw: payload,
  };
}

function formatQueueWaitLabel(waitTimeMs) {
  const ms = Number(waitTimeMs) || 0;
  if (ms <= 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

/**
 * Classify Qoder stream/HTTP failures for retry policy.
 * @returns {{
 *   kind: 'queued'|'transient'|null,
 *   waitTimeMs?: number,
 *   code?: string,
 *   queueType?: string|null,
 *   queueCount?: number|null,
 *   serviceAvailable?: boolean|null,
 *   reason?: string|null,
 * }}
 */
export function classifyQoderStreamFailure(errorText, streamError = null) {
  const text = String(errorText || streamError?.message || '');
  const type = String(streamError?.type || '');
  const objects = extractJsonObjectsFromText(text);
  if (streamError && typeof streamError === 'object') {
    objects.unshift(streamError);
  }
  for (const obj of objects) {
    const queue = normalizeQueuePayload(obj);
    if (queue) return queue;
    const nested = obj.error && typeof obj.error === 'object' ? normalizeQueuePayload(obj.error) : null;
    if (nested) return nested;
    const body = tryParseJsonObject(obj.body);
    if (body) {
      const fromBody = normalizeQueuePayload(body);
      if (fromBody) return fromBody;
    }

    const code = String(obj.code ?? obj.error_code ?? obj.errCode ?? obj.type ?? type ?? '').trim();
    const messageText = typeof obj.message === 'string' ? obj.message : '';
    const isDuplicate = code === '103'
      || type === '103'
      || /duplicate request/i.test(messageText)
      || /duplicate request/i.test(text);
    if (isDuplicate) {
      return { kind: 'transient', code: code || '103', reason: 'duplicate' };
    }
  }
  if (/10605|isQueued|queueType["']?\s*:\s*["']?slow/i.test(text)) {
    const waitMatch = text.match(/waitTime["']?\s*:\s*(\d+)/i);
    return {
      kind: 'queued',
      code: '10605',
      waitTimeMs: waitMatch ? Number(waitMatch[1]) : QODER_QUEUE_DEFAULT_WAIT_MS,
      queueType: /queueType["']?\s*:\s*["']?(\w+)/i.exec(text)?.[1] || null,
      queueCount: null,
      serviceAvailable: null,
      reason: 'queue',
    };
  }
  // 103 may arrive as bare text when JSON extraction fails.
  if (type === '103' || /duplicate request/i.test(text) || /\bcode["']?\s*:\s*["']?103\b/i.test(text)) {
    return { kind: 'transient', code: '103', reason: 'duplicate' };
  }
  // Do not treat idle_timeout as auto-retryable here: the stream already waited
  // streamIdleTimeoutMs with no data; immediate re-request usually repeats the hang.
  if (
    /\b429\b|rate limit|Rate limit|tpm|All models failed|All backends failed|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(text)
  ) {
    return { kind: 'transient', code: type || 'transient', reason: 'rate_or_transport' };
  }
  return { kind: null };
}

export function computeQoderQueueWaitMs(queueInfo, { attempt = 0 } = {}) {
  const hinted = Number(queueInfo?.waitTimeMs);
  const base = Number.isFinite(hinted) && hinted > 0 ? hinted : QODER_QUEUE_DEFAULT_WAIT_MS;
  // Cap each wait; add mild backoff so long queues do not spin too aggressively.
  const withBackoff = base + Math.min(attempt, 3) * 2_000;
  // Keep a small floor to avoid tight spin, but honor short waitTime hints (tests/local).
  return Math.min(Math.max(50, withBackoff), QODER_QUEUE_MAX_WAIT_MS);
}

/**
 * Human-readable queue status for UI + logs.
 * Keeps machine-stable keywords so tests and recovery can still match.
 */
export function formatQoderQueueStatusMessage(classification, {
  attempt,
  maxAttempts,
  waitTimeMs,
} = {}) {
  const queueType = classification?.queueType ? String(classification.queueType) : 'queue';
  const queueCount = Number.isFinite(Number(classification?.queueCount))
    ? Number(classification.queueCount)
    : null;
  const upstreamWait = formatQueueWaitLabel(classification?.waitTimeMs);
  const clientWait = formatQueueWaitLabel(waitTimeMs);
  const attemptLabel = Number.isFinite(Number(attempt)) && Number.isFinite(Number(maxAttempts))
    ? ` (retry ${Number(attempt)}/${Number(maxAttempts)})`
    : '';
  const countLabel = queueCount == null ? '' : `, position ~${queueCount}`;
  const upstreamLabel = upstreamWait ? `, upstream wait ~${upstreamWait}` : '';
  const clientLabel = clientWait ? `, waiting ${clientWait} then retry` : '';
  const unavailable = classification?.serviceAvailable === false ? '; service marked unavailable' : '';
  return `Qoder ${queueType} busy${countLabel}${upstreamLabel}${clientLabel}${unavailable}${attemptLabel}`;
}

export function formatQoderQueueError(errorText, {
  attempts,
  waitTimeMs,
  queueType,
  queueCount,
  serviceAvailable,
  upstreamWaitTimeMs,
} = {}) {
  const typeLabel = queueType ? String(queueType) : 'queue';
  const countLabel = Number.isFinite(Number(queueCount)) ? `, last position ~${Number(queueCount)}` : '';
  const clientWait = formatQueueWaitLabel(waitTimeMs);
  const upstreamWait = formatQueueWaitLabel(upstreamWaitTimeMs ?? waitTimeMs);
  const waitLabel = clientWait ? `, last client wait ${clientWait}` : '';
  const upstreamLabel = upstreamWait ? `, upstream wait ~${upstreamWait}` : '';
  const unavailable = serviceAvailable === false
    ? '. Upstream reported serviceAvailable=false'
    : '';
  const longQueue = Number(upstreamWaitTimeMs ?? waitTimeMs) >= QODER_QUEUE_LONG_WAIT_HINT_MS
    ? '. Queue is very long — try another model or retry later'
    : '';
  return `qoder_queue_timeout: still in Qoder ${typeLabel} after ${attempts} wait(s)`
    + `${countLabel}${waitLabel}${upstreamLabel}${unavailable}${longQueue}`
    + `. Upstream: ${String(errorText || '').slice(0, 240)}`;
}

export function formatQoderDuplicateError(errorText, { attempts } = {}) {
  const attemptLabel = Number.isFinite(Number(attempts)) && Number(attempts) > 0
    ? ` after ${Number(attempts)} retry attempt(s)`
    : '';
  return `qoder_duplicate_request: Qoder rejected the request as Duplicate (103)${attemptLabel}. `
    + 'Each retry already used a fresh request id; wait a moment or stop overlapping runs on the same account. '
    + `Upstream: ${String(errorText || '').slice(0, 240)}`;
}

async function sendQoderStreamWithResilience(sendOnce, {
  signal = null,
  webContents = null,
  streamId = null,
  maxQueueRetries = QODER_QUEUE_MAX_RETRIES,
  transientRetryDelaysMs = QODER_TRANSIENT_RETRY_DELAYS_MS,
  waitImpl = sleepMs,
} = {}) {
  let queueAttempts = 0;
  let transientAttempts = 0;
  let lastResult = null;
  while (true) {
    lastResult = await sendOnce();
    if (lastResult?.ok) return lastResult;
    if (signal?.aborted) return lastResult;

    const classification = classifyQoderStreamFailure(lastResult?.errorText, {
      type: lastResult?.streamErrorType,
      message: lastResult?.errorText,
      code: lastResult?.streamErrorType,
    });

    if (classification.kind === 'queued' && queueAttempts < maxQueueRetries) {
      const waitMs = computeQoderQueueWaitMs(classification, { attempt: queueAttempts });
      const message = formatQoderQueueStatusMessage(classification, {
        attempt: queueAttempts + 1,
        maxAttempts: maxQueueRetries,
        waitTimeMs: waitMs,
      });
      try {
        webContents?.send?.('chat:stream:status', {
          streamId,
          status: 'queued',
          provider: 'qoder',
          code: classification.code || '10605',
          queueType: classification.queueType,
          queueCount: classification.queueCount,
          serviceAvailable: classification.serviceAvailable,
          waitMs,
          attempt: queueAttempts + 1,
          maxAttempts: maxQueueRetries,
          message,
        });
      } catch {
        /* renderer may not listen */
      }
      await waitImpl(waitMs, signal);
      queueAttempts += 1;
      continue;
    }

    if (classification.kind === 'transient' && transientAttempts < transientRetryDelaysMs.length) {
      const waitMs = transientRetryDelaysMs[transientAttempts];
      try {
        webContents?.send?.('chat:stream:status', {
          streamId,
          status: 'retrying',
          provider: 'qoder',
          code: classification.code || 'transient',
          reason: classification.reason || null,
          waitMs,
          attempt: transientAttempts + 1,
          maxAttempts: transientRetryDelaysMs.length,
          message: classification.reason === 'duplicate'
            ? `Qoder Duplicate request (103); retrying with a fresh request id in ${formatQueueWaitLabel(waitMs) || 'a moment'} (retry ${transientAttempts + 1}/${transientRetryDelaysMs.length})`
            : `Qoder transient error; retrying in ${formatQueueWaitLabel(waitMs) || 'a moment'} (retry ${transientAttempts + 1}/${transientRetryDelaysMs.length})`,
        });
      } catch {
        /* renderer may not listen */
      }
      await waitImpl(waitMs, signal);
      transientAttempts += 1;
      continue;
    }

    if (classification.kind === 'queued') {
      return {
        ...lastResult,
        errorText: formatQoderQueueError(lastResult?.errorText, {
          attempts: queueAttempts,
          waitTimeMs: Math.min(
            Number(classification.waitTimeMs) || QODER_QUEUE_DEFAULT_WAIT_MS,
            QODER_QUEUE_MAX_WAIT_MS,
          ),
          upstreamWaitTimeMs: classification.waitTimeMs,
          queueType: classification.queueType,
          queueCount: classification.queueCount,
          serviceAvailable: classification.serviceAvailable,
        }),
        queueExhausted: true,
      };
    }

    if (classification.reason === 'duplicate' || classification.code === '103') {
      return {
        ...lastResult,
        errorText: formatQoderDuplicateError(lastResult?.errorText, {
          attempts: transientAttempts,
        }),
        duplicateExhausted: true,
      };
    }

    return lastResult;
  }
}

function qoderModelServerHost(env = process.env) {
  const explicit = String(env.QODER_MODEL_SERVER_HOST || '').trim();
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const qoderEnv = String(env.QODER_ENV || env.QODER_ENVIRONMENT || '').trim().toLowerCase();
  if (qoderEnv === 'daily') return 'daily-api2-v2.qoder.sh';
  if (qoderEnv === 'test') return 'test-api2-v2.qoder.sh';
  return 'api2-v2.qoder.sh';
}

export function qoderModelServerBaseUrl(env = process.env) {
  return `https://${qoderModelServerHost(env)}/model/v1`;
}

export function normalizeQoderPreparedEndpoint(endpoint) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname) return url.origin;
    if (/\/model\/v\d+(?:\/|$)/i.test(pathname)) return null;
    if (/\/chat\/completions(?:\/|$)/i.test(pathname)) return null;
    if (/\/algo\/api\/v\d+\/service\/pro\/sse\/agent_chat_generation(?:\/|$)/i.test(pathname)) return null;
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function normalizeQoderModel(model) {
  const raw = String(model || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  return raw;
}

function qoderContentPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (part.type === 'image_url' && part.image_url?.url) {
    const imageUrl = { url: part.image_url.url };
    // qodercli 的 qbR 只产出 {url}；detail 仅在显式设置时透传，避免悬空 undefined。
    if (part.image_url.detail != null) imageUrl.detail = part.image_url.detail;
    return { type: 'image_url', image_url: imageUrl };
  }
  if (part.type === 'tool_use') {
    const name = typeof part.name === 'string' ? part.name : 'tool';
    const id = typeof part.id === 'string' ? part.id : '';
    const input = part.input && typeof part.input === 'object' ? JSON.stringify(part.input) : '{}';
    return { type: 'text', text: `[tool_use ${name}${id ? ` ${id}` : ''}] ${input}` };
  }
  if (part.type === 'tool_result') {
    const id = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
    return { type: 'text', text: `[tool_result${id ? ` ${id}` : ''}] ${qoderContentText(part.content)}` };
  }
  if (typeof part.content === 'string') return { type: 'text', text: part.content };
  return null;
}

function qoderContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function qoderToolCallArguments(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return JSON.stringify({ raw_arguments: value });
    }
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '{}';
}

function qoderToolCall(toolCall, index) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
  const name = typeof fn.name === 'string' && fn.name.trim()
    ? fn.name.trim()
    : typeof toolCall.name === 'string' ? toolCall.name.trim() : '';
  if (!name) return null;
  return {
    id: String(toolCall.id || `qoder_history_tool_${index + 1}`),
    type: 'function',
    function: {
      name,
      arguments: qoderToolCallArguments(fn.arguments ?? toolCall.arguments ?? toolCall.input ?? {}),
    },
  };
}

/**
 * qodercli 对 user/assistant 会同时发送 content 与 contents。
 * - 有文本时：contents=[{type:'text', text}]
 * - 带图片时：contents 同样携带 {type:'image_url', image_url:{url}} 分片
 *   （qodercli 1.1.7 逆向确认：user 消息的 contents=Q 包含 image_url 分片，
 *   base64 data URL 与普通 URL 均合法；chat_context.imageUrls 官方恒为 null）。
 * - 无文本时（如 assistant 仅 tool_calls）：contents=[]
 * 不要发 contents=[{type:'text', text:''}]，Kimi 等上游会报
 * "Invalid request: text content is empty"。
 */
function qoderMessageContents(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', text: content }] : [];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) parts.push({ type: 'text', text: part });
        continue;
      }
      if (part?.type === 'text' && typeof part.text === 'string') {
        if (part.text.trim()) parts.push({ type: 'text', text: part.text });
        continue;
      }
      if (part?.type === 'image_url' && part.image_url?.url) {
        parts.push({ type: 'image_url', image_url: { url: String(part.image_url.url) } });
      }
    }
    return parts;
  }
  if (content == null) return [];
  const text = qoderContentText(content);
  return text.trim() ? [{ type: 'text', text }] : [];
}

function qoderMessage(message) {
  const role = String(message?.role || '').trim();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const content = message.content;
  const output = { role };
  if (typeof content === 'string' || content === null) {
    // Keep null as empty string for assistant/tool-call messages so contents stays [].
    output.content = content == null ? '' : content;
  } else if (Array.isArray(content)) {
    const parts = content.map(qoderContentPart).filter(Boolean);
    output.content = parts.length ? parts : '';
  } else if (content && typeof content === 'object') {
    const part = qoderContentPart(content);
    output.content = part ? [part] : '';
  } else {
    output.content = '';
  }
  // Align with qodercli FREE_INPUT body: user/assistant carry dual content/contents.
  if (role === 'user' || role === 'assistant') {
    output.contents = qoderMessageContents(output.content);
  }
  if (message.name) output.name = message.name;
  if (message.tool_call_id) output.tool_call_id = message.tool_call_id;
  if (Array.isArray(message.tool_calls)) {
    const toolCalls = message.tool_calls.map(qoderToolCall).filter(Boolean);
    if (toolCalls.length) output.tool_calls = toolCalls;
  }
  // qodercli drops empty user messages; empty contents also crash some models.
  if (role === 'user' && !qoderMessageHasText(output.content) && !output.tool_calls?.length) {
    return null;
  }
  return output;
}

function qoderMessageHasText(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      if (part.type === 'text') return typeof part.text === 'string' && part.text.trim().length > 0;
      return true;
    });
  }
  return false;
}

/**
 * 修复 OpenAI 风格历史在 Anthropic 系模型（如 Qoder ultimate）上的工具消息配对问题。
 *
 * 背景：内部历史统一用 OpenAI 结构表达工具调用
 *   - assistant: { tool_calls: [{ id, ... }] }
 *   - tool:      { tool_call_id, content }
 * 上游把它转成 Anthropic 的 tool_use / tool_result 块时，要求每个 tool_result 都有
 * 紧邻的配对 tool_use。长历史被上下文裁剪后，常出现：
 *   1) 孤儿 tool_result —— 对应的 assistant.tool_calls 头被裁掉（触发
 *      "unexpected tool_use_id found in tool_result blocks" 报错）；
 *   2) 悬空 tool_calls —— assistant 声明了调用但结果被裁掉（反向的
 *      "tool_use without tool_result"）。
 *
 * 本函数按顺序做双向配对清洗：只保留“既被 assistant 声明、又有对应结果”的成对工具消息，
 * 丢弃孤儿 tool_result 与悬空 tool_calls。对 OpenAI 系模型是无害的（只会让消息更规范）。
 */
export function sanitizeQoderToolPairing(messages) {
  if (!Array.isArray(messages)) return [];
  const resultIds = new Set();
  for (const message of messages) {
    if (String(message?.role || '').trim() !== 'tool') continue;
    const id = message?.tool_call_id;
    if (typeof id === 'string' && id) resultIds.add(id);
  }

  const lastIndex = messages.length - 1;
  const declaredToolCallIds = new Set();
  const output = [];
  messages.forEach((message, index) => {
    const role = String(message?.role || '').trim();

    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      // 末尾 assistant 的 tool_use 是合法的“等待结果”态，予以保留；
      // 中间的悬空 tool_use（结果被裁掉）会破坏 Anthropic 的成对约束，需剥离。
      const isLast = index === lastIndex;
      const keptCalls = message.tool_calls.filter((call) => {
        const id = call?.id;
        if (typeof id !== 'string' || !id) return false;
        return resultIds.has(id) || isLast;
      });
      if (keptCalls.length) {
        for (const call of keptCalls) declaredToolCallIds.add(call.id);
        output.push(
          keptCalls.length === message.tool_calls.length
            ? message
            : { ...message, tool_calls: keptCalls },
        );
      } else if (qoderMessageHasText(message.content)) {
        // 所有调用都悬空：去掉 tool_calls，仅当仍有文本时保留该 assistant
        const { tool_calls: _dropped, ...rest } = message;
        output.push(rest);
      }
      // 否则整条丢弃（纯悬空调用、无实际内容）
      return;
    }

    if (role === 'tool') {
      const id = message?.tool_call_id;
      // 仅保留“前面有配对 tool_use”的 tool_result，丢弃孤儿（正是上游报错的根因）。
      if (typeof id === 'string' && declaredToolCallIds.has(id)) {
        output.push(message);
      }
      return;
    }

    output.push(message);
  });
  return output;
}

function normalizeAssistantTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * 合并相邻的 assistant 消息，修复 Anthropic 系模型（Qoder ultimate）的工具配对报错。
 *
 * 根因：内部历史把每个工具轮拆成两条连续的 assistant 消息：
 *   1) 一条叙述文本 assistant（content 为文字）
 *   2) 一条 { content: null, tool_calls: [...] } 的调用 assistant
 * 上游把 OpenAI 结构转成 Anthropic 时，要求 user/assistant 角色严格交替；两条连续的
 * assistant 会被合并，而 content:null 的那条在合并中丢掉了 tool_use 块，导致其后的
 * tool_result 找不到配对的 tool_use（报错 "unexpected tool_use_id found in tool_result
 * blocks"，指向 messages.2）。
 *
 * 修复：在发送前把相邻 assistant 合并为一条——文本拼接、tool_calls 合并，且当该 assistant
 * 带 tool_calls 时绝不发送 content:null（回退为空字符串），产出规范的
 * user → assistant(text + tool_use) → tool 结构。
 */
export function mergeConsecutiveAssistants(messages) {
  if (!Array.isArray(messages)) return [];
  const output = [];
  for (const message of messages) {
    const role = String(message?.role || '').trim();
    const prev = output[output.length - 1];
    if (role === 'assistant' && prev && String(prev.role || '').trim() === 'assistant') {
      const prevText = normalizeAssistantTextContent(prev.content);
      const curText = normalizeAssistantTextContent(message.content);
      const mergedText = [prevText, curText].filter((t) => t && t.trim()).join('\n\n');
      const mergedToolCalls = [
        ...(Array.isArray(prev.tool_calls) ? prev.tool_calls : []),
        ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
      ];
      const merged = { ...prev, ...message, role: 'assistant' };
      if (mergedToolCalls.length) {
        merged.tool_calls = mergedToolCalls;
        // 带 tool_calls 的 assistant 绝不发 null，否则上游合并时会丢掉 tool_use 块
        merged.content = mergedText;
      } else {
        merged.content = mergedText || message.content || prev.content || '';
      }
      output[output.length - 1] = merged;
      continue;
    }

    // 单独的、带 tool_calls 但 content 为 null 的 assistant 也需回退为空串
    if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length && message.content == null) {
      output.push({ ...message, content: normalizeAssistantTextContent(message.content) });
      continue;
    }

    output.push(message);
  }
  return output;
}

function qoderLastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => typeof part === 'string' ? part : part?.text || part?.content || '')
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function qoderPrimitiveType(type) {
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    return type.find((entry) => typeof entry === 'string' && entry !== 'null') || 'string';
  }
  return null;
}

function qoderCompatibleSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' };
  if (depth > 8) return { type: 'string' };
  const variant = schema.oneOf?.[0] || schema.anyOf?.[0] || schema.allOf?.[0];
  if (!schema.type && variant && typeof variant === 'object') {
    return qoderCompatibleSchema({ ...variant, description: schema.description ?? variant.description }, depth + 1);
  }
  const type = qoderPrimitiveType(schema.type) || (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  const out = { type };
  if (typeof schema.description === 'string' && schema.description.trim()) out.description = schema.description;
  if (Array.isArray(schema.enum)) {
    const enumValues = schema.enum.filter((entry) => {
      if (entry === null) return false;
      if (type === 'integer') return Number.isInteger(entry);
      if (type === 'number') return typeof entry === 'number';
      if (type === 'boolean') return typeof entry === 'boolean';
      return typeof entry === 'string';
    });
    if (enumValues.length) out.enum = enumValues;
  }
  if (type === 'object') {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      if (/^[a-zA-Z0-9_.-]+$/.test(key)) properties[key] = qoderCompatibleSchema(value, depth + 1);
    }
    out.properties = properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key))
      : [];
    if (required.length) out.required = required;
    out.additionalProperties = schema.additionalProperties === true ? true : false;
  }
  if (type === 'array') {
    out.items = qoderCompatibleSchema(schema.items || { type: 'string' }, depth + 1);
  }
  return out;
}

function qoderCompatibleTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return null;
  return {
    type: 'function',
    function: {
      name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: qoderCompatibleSchema(fn.parameters || fn.input_schema || { type: 'object' }),
    },
  };
}

function qoderCompatibleTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(qoderCompatibleTool).filter(Boolean);
}

export function buildQoderRemoteChatAsk({
  model,
  messages,
  tools = [],
  maxOutputTokens,
  requestId,
  requestSetId,
  sessionId,
  taskId,
  isRetry = false,
  metadata = null,
  modelOptionValues = {},
} = {}) {
  const optionProjection = resolveQoderModelOptionProjection(metadata, modelOptionValues);
  const sanitizedInput = mergeConsecutiveAssistants(sanitizeQoderToolPairing(messages));
  const normalizedMessages = sanitizedInput.map(qoderMessage).filter(Boolean);
  // qodercli keeps system both at top-level `system` and as the first messages entry.
  const systemMessage = normalizedMessages.find((message) => message.role === 'system');
  const systemPrompt = typeof systemMessage?.content === 'string'
    ? systemMessage.content
    : qoderContentText(systemMessage?.content);
  const conversationMessages = normalizedMessages.filter((message) => message.role !== 'system');
  const requestMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...conversationMessages]
    : conversationMessages;
  const modelKey = metadata?.id || normalizeQoderModel(model);
  const source = metadata?.source || 'system';
  const isReasoning = Boolean(metadata?.supportsReasoning);
  const parameters = {};
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    parameters.max_tokens = Math.trunc(maxOutputTokens);
  }
  return {
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: qoderLastUserText(normalizedMessages),
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: qoderLastUserText(normalizedMessages),
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: Boolean(isRetry),
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: taskId || 'peer-agent',
    session_type: process.env.QODER_SESSION_TYPE || 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      display_name: metadata?.label || modelKey,
      model: '',
      format: metadata?.format || 'openai',
      is_vl: Boolean(metadata?.supportsVision),
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source,
      max_input_tokens: optionProjection.contextWindow || metadata?.contextWindow || 200000,
      ...optionProjection.requestOptions,
    },
    custom_model: null,
    system: systemPrompt,
    messages: requestMessages,
    tools: qoderCompatibleTools(tools),
    parameters,
    // qodercli always includes business (via lrI). Ultimate routing to
    // oa_qwen-plus fails with Execution failed when this field is absent.
    business: {},
  };
}

async function getQoderModelMetadataForSend(model) {
  // Stream send must not block on live catalog discovery (official SDK can take seconds).
  // Use the latest local/sync cache only; missing metadata still allows a valid request body.
  return getQoderModelMetadata(model);
}

export function qoderTurnTaskId(streamId) {
  const base = String(streamId || 'peer-agent').trim() || 'peer-agent';
  return `${base}:${crypto.randomUUID()}`;
}

async function sendQoderPreparedStream({
  apiKey,
  model,
  messages,
  tools,
  maxOutputTokens,
  signal,
  webContents,
  streamId,
  endpoint = null,
  bufferThinkingDeltas = false,
  emitBufferedThinkingDeltas = true,
  streamIdleTimeoutMs = 0,
  modelOptions,
  modelOptionValues = {},
} = {}) {
  // Keep non-identity payload (messages/tools/metadata) stable across connection
  // recovery, but regenerate request_id/session_id/task_id on every attempt so a
  // timed-out first socket is not rejected by Qoder as Duplicate request (103).
  const catalogMetadata = await getQoderModelMetadataForSend(model);
  const metadata = catalogMetadata && Array.isArray(modelOptions)
    ? { ...catalogMetadata, modelOptions }
    : catalogMetadata;
  const resolvedEndpoint = normalizeQoderPreparedEndpoint(endpoint) || await resolveQoderInferenceEndpoint();
  let requestBody = null;
  let preparedUrl = null;

  const buildConnectionAttemptInit = async ({ isRetry }) => {
    const requestId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    requestBody = buildQoderRemoteChatAsk({
      model,
      messages,
      tools,
      maxOutputTokens,
      requestId,
      requestSetId: requestId,
      sessionId,
      taskId: qoderTurnTaskId(streamId),
      isRetry,
      metadata,
      modelOptionValues,
    });
    const prepared = await prepareQoderInferRequest({
      requestBody,
      modelKey: requestBody.model_config.key,
      modelSource: requestBody.model_config.source,
      endpoint: resolvedEndpoint,
    });
    preparedUrl = prepared.url;
    const headers = {
      ...prepared.headers,
      Accept: prepared.headers.Accept || prepared.headers.accept || 'text/event-stream',
    };
    if (apiKey && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    return {
      method: 'POST',
      headers,
      body: prepared.body,
      signal,
    };
  };

  // Build the first attempt eagerly so requestBody is available for tracing and
  // error paths even if recovery never succeeds.
  const firstInit = await buildConnectionAttemptInit({ isRetry: false });
  const trace = createProviderStreamTrace({
    provider: 'qoder',
    baseUrl: preparedUrl || endpoint,
    model: requestBody.model_config.key,
    effort: 'off',
    supportsReasoning: Boolean(requestBody.model_config.is_reasoning),
    streamId,
    requestBody: {
      model: requestBody.model_config.key,
      messages: requestBody.messages,
      tools: requestBody.tools,
      stream: true,
      max_tokens: requestBody.parameters?.max_tokens,
    },
  });

  let firstAttemptUsed = false;
  const res = await fetchWithConnectionRecovery(preparedUrl, firstInit, {
    webContents,
    streamId,
    provider: 'qoder',
    model: requestBody.model_config.key,
    retryDelaysMs: QODER_CONNECTION_RETRY_DELAYS_MS,
    buildInit: async ({ attempt, isRetry }) => {
      if (attempt === 0 && !firstAttemptUsed) {
        firstAttemptUsed = true;
        return firstInit;
      }
      return buildConnectionAttemptInit({ isRetry });
    },
  });
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: requestBody.messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeOpenAIStream(res, webContents, streamId, trace, signal, {
    bufferTextDeltas: true,
    bufferThinkingDeltas,
    emitBufferedThinkingDeltas,
    streamIdleTimeoutMs,
  });
  if (streamResult.streamError) {
    const errorText = `provider_stream_error: ${streamResult.streamError.message}`;
    const tracePath = await trace.finish({
      anomaly: 'provider_stream_error',
      httpError: errorText,
      result: {
        ok: false,
        status: res.status,
        streamErrorType: streamResult.streamError.type,
        textChars: streamResult.content.length,
        thinkingChars: streamResult.thinkingContent.length,
        toolCallCount: streamResult.toolCalls.length,
      },
    });
    return {
      ok: false,
      status: res.status,
      errorText,
      providerError: true,
      streamErrorType: streamResult.streamError.type,
      messages: requestBody.messages,
      providerTracePath: tracePath,
    };
  }

  const anomaly =
    !String(streamResult.content || '').trim() &&
    !String(streamResult.thinkingContent || '').trim() &&
    !streamResult.toolCalls.length
      ? 'empty_stream_result'
      : null;
  const tracePath = await trace.finish({
    anomaly,
    result: {
      ok: true,
      status: res.status,
      textChars: streamResult.content.length,
      thinkingChars: streamResult.thinkingContent.length,
      toolCallCount: streamResult.toolCalls.length,
      hasUsage: Boolean(streamResult.streamUsage),
    },
  });

  return {
    ok: true,
    messages: requestBody.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}

export function buildQoderPrivateRequestBody({
  model,
  messages = [],
  tools = [],
  maxOutputTokens = 0,
  requestId = crypto.randomUUID(),
  requestSetId = requestId,
  sessionId = crypto.randomUUID(),
  taskId = 'peer-agent',
} = {}) {
  const body = {
    model: normalizeQoderModel(model),
    messages: mergeConsecutiveAssistants(sanitizeQoderToolPairing(messages)).map(qoderMessage).filter(Boolean),
    stream: true,
    stream_options: { include_usage: true },
    tools: qoderCompatibleTools(tools),
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: requestSetId,
        session_id: sessionId,
        task_id: taskId,
        client_type: '5',
      },
    },
  };
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    body.max_tokens = Math.trunc(maxOutputTokens);
  }
  return body;
}

export function buildQoderPrivateHeaders({ token, requestId, sessionId } = {}) {
  return {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Request-ID': requestId,
    'X-Session-ID': sessionId,
  };
}

export async function sendQoderPrivateStream({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  maxOutputTokens,
  signal,
  webContents,
  streamId,
  endpoint = null,
  bufferThinkingDeltas = false,
  emitBufferedThinkingDeltas = true,
  streamIdleTimeoutMs = 0,
  modelOptions,
  modelOptionValues = {},
  maxQueueRetries = QODER_QUEUE_MAX_RETRIES,
  transientRetryDelaysMs = QODER_TRANSIENT_RETRY_DELAYS_MS,
  waitImpl = sleepMs,
} = {}) {
  return sendQoderStreamWithResilience(async () => {
  const catalogMetadata = await getQoderModelMetadataForSend(model);
  // Prefer agent_chat_generation whenever we have catalog metadata OR the UI
  // has persisted modelOptions (e.g. kmodel_latest synced as metadataSource=remote
  // but not yet present in the local encrypted catalog). Falling back to
  // /model/v1 for those models returns HTTP 402 quota exceeded.
  const metadata = catalogMetadata
    ? (Array.isArray(modelOptions) ? { ...catalogMetadata, modelOptions } : catalogMetadata)
    : (Array.isArray(modelOptions) && modelOptions.length
      ? {
          id: normalizeQoderModel(model),
          label: String(model || ''),
          source: 'system',
          format: 'openai',
          modelOptions,
          maxOutputTokens: Number(maxOutputTokens) || 0,
          supportsVision: true,
          supportsReasoning: false,
        }
      : null);
  if (metadata) {
    return sendQoderPreparedStream({
      apiKey,
      model,
      messages,
      tools,
      maxOutputTokens,
      signal,
      webContents,
      streamId,
      endpoint,
      bufferThinkingDeltas,
      emitBufferedThinkingDeltas,
      streamIdleTimeoutMs,
      modelOptions: metadata.modelOptions,
      modelOptionValues,
    });
  }
  const root = String(baseUrl || qoderModelServerBaseUrl()).replace(/\/+$/, '');
  const url = endpoint || `${root}/chat/completions`;
  let body = null;

  const buildPrivateConnectionAttemptInit = ({ isRetry }) => {
    const requestId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    body = buildQoderPrivateRequestBody({
      model,
      messages,
      tools,
      maxOutputTokens,
      requestId,
      requestSetId: requestId,
      sessionId,
      taskId: qoderTurnTaskId(streamId),
      metadata,
      modelOptionValues,
    });
    // Legacy /model/v1 path has no is_retry field; fresh request_id is enough.
    void isRetry;
    return {
      method: 'POST',
      headers: buildQoderPrivateHeaders({ token: apiKey, requestId, sessionId }),
      body: JSON.stringify(body),
      signal,
    };
  };

  const firstInit = buildPrivateConnectionAttemptInit({ isRetry: false });
  const trace = createProviderStreamTrace({
    provider: 'qoder',
    baseUrl: root,
    model: body.model,
    effort: 'off',
    supportsReasoning: false,
    streamId,
    requestBody: body,
  });

  let firstAttemptUsed = false;
  const res = await fetchWithConnectionRecovery(url, firstInit, {
    webContents,
    streamId,
    provider: 'qoder',
    model: body.model,
    retryDelaysMs: QODER_CONNECTION_RETRY_DELAYS_MS,
    buildInit: ({ attempt, isRetry }) => {
      if (attempt === 0 && !firstAttemptUsed) {
        firstAttemptUsed = true;
        return firstInit;
      }
      return buildPrivateConnectionAttemptInit({ isRetry });
    },
  });
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    if (tracePath) console.warn(`[provider-trace] wrote Qoder HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: body.messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeOpenAIStream(res, webContents, streamId, trace, signal, {
    bufferTextDeltas: true,
    bufferThinkingDeltas,
    emitBufferedThinkingDeltas,
    streamIdleTimeoutMs,
  });
  if (streamResult.streamError) {
    const errorText = `provider_stream_error: ${streamResult.streamError.message}`;
    const tracePath = await trace.finish({
      anomaly: 'provider_stream_error',
      httpError: errorText,
      result: {
        ok: false,
        status: res.status,
        streamErrorType: streamResult.streamError.type,
        textChars: streamResult.content.length,
        thinkingChars: streamResult.thinkingContent.length,
        toolCallCount: streamResult.toolCalls.length,
      },
    });
    return {
      ok: false,
      status: res.status,
      errorText,
      providerError: true,
      streamErrorType: streamResult.streamError.type,
      messages: body.messages,
      providerTracePath: tracePath,
    };
  }

  const anomaly =
    !String(streamResult.content || '').trim() &&
    !String(streamResult.thinkingContent || '').trim() &&
    !streamResult.toolCalls.length
      ? 'empty_stream_result'
      : null;
  const tracePath = await trace.finish({
    anomaly,
    result: {
      ok: true,
      status: res.status,
      textChars: streamResult.content.length,
      thinkingChars: streamResult.thinkingContent.length,
      toolCallCount: streamResult.toolCalls.length,
      hasUsage: Boolean(streamResult.streamUsage),
    },
  });
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote Qoder empty stream trace: ${tracePath}`);

  return {
    ok: true,
    messages: body.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
  }, {
    signal,
    webContents,
    streamId,
    maxQueueRetries,
    transientRetryDelaysMs,
    waitImpl,
  });
}
