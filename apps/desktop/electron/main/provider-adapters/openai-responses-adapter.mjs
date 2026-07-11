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

import { hasLiteralToolCallSyntax } from '../chat-runtime/response-guard.mjs';
import { encodeOpenAIResponsesRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { parseSseDataPayload, throwIfSseReaderAborted } from './sse-line.mjs';

function extractCachedInputTokens(usage) {
  return usage?.input_tokens_details?.cached_tokens
    ?? usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_cache_hit
    ?? 0;
}

function consumeResponsesEvent(parsed, state, webContents, streamId) {
  const type = parsed?.type;
  if (!type) return;

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
      break;
    }
    case 'response.failed':
    case 'error': {
      const err = parsed.response?.error || parsed.error || parsed;
      state.streamError = {
        type: err.code || err.type || 'provider_stream_error',
        message: err.message || JSON.stringify(err),
      };
      break;
    }
    default:
      break;
  }
}

function consumeResponsesLine(line, state, webContents, streamId, trace = null) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const payload = parseSseDataPayload(trimmed);
  if (payload === null) {
    trace?.recordIgnoredLine?.(trimmed);
    return;
  }
  if (payload === '[DONE]') {
    trace?.recordDoneMarker?.();
    return;
  }
  try {
    const parsed = JSON.parse(payload);
    trace?.recordSsePayload?.(payload, parsed);
    consumeResponsesEvent(parsed, state, webContents, streamId);
  } catch (error) {
    trace?.recordParseError?.(payload, error);
  }
}

async function consumeResponsesStream(res, webContents, streamId, trace = null, signal = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    content: '',
    thinkingContent: '',
    toolCallsById: {},
    usage: null,
    streamError: null,
  };

  while (true) {
    await throwIfSseReaderAborted(signal, reader);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      consumeResponsesLine(line, state, webContents, streamId, trace);
      await throwIfSseReaderAborted(signal, reader);
    }
  }
  await throwIfSseReaderAborted(signal, reader);
  if (buffer.trim()) consumeResponsesLine(buffer, state, webContents, streamId, trace);

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

  const streamResult = await consumeResponsesStream(res, webContents, streamId, trace, signal);
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
