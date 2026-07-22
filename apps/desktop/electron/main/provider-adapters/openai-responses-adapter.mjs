// OpenAI Responses API 流式传输适配器(ChatGPT 订阅链路)。ADR 28。
//
// 与 openai-chat-adapter 返回相同的契约:
//   { ok, status?, errorText?, messages, providerTracePath, content,
//     thinkingContent, toolCalls, streamUsage, streamError }
// 以便复用 openai-agent-loop 的循环、工具执行与终态处理。
//
// 差异点:
// - 端点为 `${baseUrl}/responses`。
// - 鉴权用 Bearer access_token + chatgpt-account-id 头。
// - 流式事件为 typed SSE events,需要按事件类型解析。
// - 语义终态（response.completed / failed / [DONE]）后立即结束读循环，
//   并提供 idle timeout，避免 Grok/代理在 completed 后挂连接导致 UI 永不解锁。

import { hasLiteralToolCallSyntax } from '../chat-runtime/response-guard.mjs';
import { encodeOpenAIResponsesRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { parseSseDataPayload, throwIfSseReaderAborted } from './sse-line.mjs';

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

function extractCachedInputTokens(usage) {
  return usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_cache_hit
    ?? 0;
}

function streamIdleTimeoutError(ms) {
  const error = new Error(`provider_stream_idle_timeout: no SSE data received for ${ms}ms`);
  error.type = 'provider_stream_idle_timeout';
  return error;
}

async function readStreamChunk(reader, signal, idleTimeoutMs) {
  const timeoutMs = Number(idleTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reader.read();
  let timer = null;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(streamIdleTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    try {
      await reader.cancel(error);
    } catch {
      /* stream may already be closed */
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancelResponsesReader(reader, reason) {
  try {
    await reader.cancel(reason);
  } catch {
    /* stream may already be closed */
  }
}

function consumeResponsesEvent(parsed, state, webContents, streamId) {
  const type = parsed?.type;
  if (!type) return null;

  switch (type) {
    case 'response.output_text.delta': {
      const delta = parsed.delta || '';
      if (delta) {
        state.content += delta;
        if (hasLiteralToolCallSyntax(delta)) {
          state.pseudoToolTextDetected = true;
        }
        webContents.send('chat:stream:delta', { streamId, content: delta });
      }
      break;
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = parsed.delta || '';
      if (delta) {
        state.thinkingContent += delta;
        webContents.send('chat:stream:thinking', { streamId, content: delta });
      }
      break;
    }
    case 'response.output_item.added': {
      // 工具调用项开始:记录 call_id / name。
      const item = parsed.item;
      if (item?.type === 'function_call') {
        state.toolCallsById[item.id] = {
          id: item.call_id || item.id,
          name: item.name || '',
          arguments: '',
        };
      }
      break;
    }
    case 'response.function_call_arguments.delta': {
      const entry = state.toolCallsById[parsed.item_id];
      if (entry && parsed.delta) {
        entry.arguments += parsed.delta;
        emitToolArgProgress(entry, {
          webContents,
          streamId,
          toolCallId: entry.id,
          toolName: entry.name,
          argsJson: entry.arguments,
        });
      }
      break;
    }
    case 'response.function_call_arguments.done': {
      const entry = state.toolCallsById[parsed.item_id];
      if (entry && typeof parsed.arguments === 'string' && !entry.arguments) {
        entry.arguments = parsed.arguments;
      }
      break;
    }
    case 'response.completed': {
      const usage = parsed.response?.usage;
      if (usage) {
        const cachedTokens = extractCachedInputTokens(usage);
        const inputTokens = usage.input_tokens ?? 0;
        state.usage = {
          // Responses input_tokens 已包含 cached_tokens；内部账本字段必须互斥，
          // 否则 context meter 做 input + cacheRead 时会把缓存命中重复计算。
          inputTokens: Math.max(0, inputTokens - cachedTokens),
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: cachedTokens,
          cacheWriteTokens: 0,
        };
        webContents.send('chat:stream:usage', { streamId, usage: state.usage });
      }
      // 语义终态：Grok/部分代理在 completed 后可能不关 TCP，不能再死等 reader.read()。
      state.terminal = 'completed';
      return 'completed';
    }
    case 'response.failed':
    case 'error': {
      const err = parsed.response?.error || parsed.error || parsed;
      state.streamError = {
        type: err.code || err.type || 'provider_stream_error',
        message: err.message || JSON.stringify(err),
      };
      state.terminal = 'failed';
      return 'failed';
    }
    default:
      break;
  }
  return null;
}

function consumeResponsesLine(line, state, webContents, streamId, trace = null) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const payload = parseSseDataPayload(trimmed);
  if (payload === null) {
    trace?.recordIgnoredLine?.(trimmed);
    return null;
  }
  if (payload === '[DONE]') {
    trace?.recordDoneMarker?.();
    state.terminal = 'completed';
    return 'completed';
  }
  try {
    const parsed = JSON.parse(payload);
    trace?.recordSsePayload?.(payload, parsed);
    return consumeResponsesEvent(parsed, state, webContents, streamId);
  } catch (error) {
    trace?.recordParseError?.(payload, error);
    return null;
  }
}

/**
 * 消费 Responses SSE。
 * @param {Response} res
 * @param {*} webContents
 * @param {string} streamId
 * @param {*} [trace]
 * @param {AbortSignal|null} [signal]
 * @param {{ streamIdleTimeoutMs?: number }} [options]
 *   streamIdleTimeoutMs：无数据空闲超时；默认 30s。传 0 关闭超时（仅测试/特殊场景）。
 */
async function consumeResponsesStream(
  res,
  webContents,
  streamId,
  trace = null,
  signal = null,
  options = {},
) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const idleTimeoutMs = Object.prototype.hasOwnProperty.call(options, 'streamIdleTimeoutMs')
    ? options.streamIdleTimeoutMs
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const state = {
    content: '',
    thinkingContent: '',
    toolCallsById: {},
    usage: null,
    streamError: null,
    terminal: null,
  };

  while (!state.terminal) {
    await throwIfSseReaderAborted(signal, reader);
    let chunk;
    try {
      chunk = await readStreamChunk(reader, signal, idleTimeoutMs);
    } catch (error) {
      if (error?.type === 'provider_stream_idle_timeout') {
        // 已有语义终态时，空闲超时只用于切断挂死连接，不覆盖已完成结果。
        if (state.terminal) break;
        state.streamError = {
          type: error.type,
          message: error.message,
        };
        break;
      }
      throw error;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const terminal = consumeResponsesLine(line, state, webContents, streamId, trace);
      await throwIfSseReaderAborted(signal, reader);
      if (terminal) {
        await cancelResponsesReader(reader, terminal);
        break;
      }
    }
  }
  await throwIfSseReaderAborted(signal, reader);
  if (!state.terminal && buffer.trim()) {
    consumeResponsesLine(buffer, state, webContents, streamId, trace);
  }

  return {
    content: state.content,
    thinkingContent: state.thinkingContent,
    toolCalls: Object.values(state.toolCallsById).filter((tc) => tc && tc.name),
    streamUsage: state.usage,
    streamError: state.streamError,
    pseudoToolTextDetected: Boolean(state.pseudoToolTextDetected),
  };
}

export async function sendOpenAIResponsesStream({
  baseUrl,
  apiKey,
  accountId,
  endpoint,
  headers: resolvedHeaders,
  model,
  messages,
  tools,
  effort,
  supportsReasoning,
  reasoningParamStyle = 'openai-effort',
  maxOutputTokens,
  reasoningEffortMap,
  omitMaxOutputTokens = false,
  signal,
  webContents,
  streamId,
  // 默认 30s：防止 completed 后连接不关导致 UI isStreaming 永久悬挂。
  streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
}) {
  const url = endpoint || `${baseUrl.replace(/\/+$/, '')}/responses`;
  const body = encodeOpenAIResponsesRequest({ model, messages, tools, effort, supportsReasoning, reasoningParamStyle, maxOutputTokens, reasoningEffortMap, omitMaxOutputTokens });

  const trace = createProviderStreamTrace({
    provider: 'openai-responses',
    baseUrl,
    model,
    effort,
    supportsReasoning,
    streamId,
    requestBody: body,
  });

  const headers = resolvedHeaders || {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'OpenAI-Beta': 'responses=experimental',
  };
  if (!resolvedHeaders && accountId) headers['chatgpt-account-id'] = accountId;

  const res = await fetchWithConnectionRecovery(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  }, {
    webContents,
    streamId,
    provider: 'openai-responses',
    model,
  });
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    if (tracePath) console.warn(`[provider-trace] wrote OpenAI Responses HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeResponsesStream(res, webContents, streamId, trace, signal, {
    streamIdleTimeoutMs,
  });
  const pseudoToolTextAnomaly = Boolean(streamResult.pseudoToolTextDetected);
  if (streamResult.streamError) {
    const errorText = `provider_stream_error: ${streamResult.streamError.message}`;
    const tracePath = await trace.finish({
      anomaly: 'stream_error',
      result: { ok: false, streamError: streamResult.streamError },
    });
    return {
      ok: false,
      providerError: true,
      errorText,
      messages,
      providerTracePath: tracePath,
      ...streamResult,
    };
  }

  const emptyStreamAnomaly =
    !streamResult.content && !streamResult.toolCalls.length && !streamResult.thinkingContent;
  const anomaly = pseudoToolTextAnomaly
    ? 'pseudo_tool_text_delta'
    : emptyStreamAnomaly
      ? 'empty_stream'
      : null;
  const tracePath = await trace.finish({
    anomaly,
    result: {
      ok: true,
      hasContent: Boolean(streamResult.content),
      toolCallCount: streamResult.toolCalls.length,
      hasUsage: Boolean(streamResult.streamUsage),
      pseudoToolTextDetected: pseudoToolTextAnomaly,
    },
  });
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote OpenAI Responses anomaly trace (${anomaly}): ${tracePath}`);

  return {
    ok: true,
    messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}

// 测试入口：挂死连接 + completed 事件场景。
export const __test__ = {
  consumeResponsesStream,
  consumeResponsesLine,
  streamIdleTimeoutError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
};
