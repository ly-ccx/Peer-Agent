import { consumeOpenAIChatStream } from '@peer-agent/runtime-node';

import { encodeOpenAIChatRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { parseSseDataPayload, throwIfSseReaderAborted } from './sse-line.mjs';
import { hasLiteralToolCallSyntax } from '../chat-runtime/response-guard.mjs';

export function shouldUsePublicOpenAIChatStream(resolvedChannel, useResponses = false) {
  return (
    !useResponses &&
    (resolvedChannel?.channelId === 'openai' || resolvedChannel?.channelId === 'grok') &&
    resolvedChannel?.wire === 'openai-chat'
  );
}

function extractTextLikeDelta(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => extractTextLikeDelta(part))
      .filter(Boolean)
      .join('');
  }
  if (value && typeof value === 'object') {
    return extractTextLikeDelta(
      value.text ?? value.content ?? value.delta ?? value.summary ?? value.output_text,
    );
  }
  return '';
}

function extractOpenAIReasoningDelta(delta) {
  if (!delta || typeof delta !== 'object') return '';
  const fields = [
    'reasoning_content',
    'reasoning',
    'reasoning_text',
    'thinking',
    'thinking_content',
    'reasoning_summary',
  ];
  for (const field of fields) {
    const text = extractTextLikeDelta(delta[field]);
    if (text) return text;
  }
  return '';
}

function extractOpenAIStreamError(parsed) {
  const error = parsed?.error ?? parsed?.choices?.[0]?.delta?.error;
  if (!error) return null;
  if (typeof error === 'string') return { type: 'provider_stream_error', message: error };
  const details = typeof error.details === 'string' ? error.details : '';
  const message = error.message || JSON.stringify(error);
  return {
    type: error.type || error.code || 'provider_stream_error',
    message: details ? `${message}: ${details}` : message,
  };
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractProviderEnvelopeError(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const statusValue = Number(parsed.statusCodeValue ?? parsed.status);
  const hasErrorStatus = Number.isFinite(statusValue) && statusValue >= 400;
  const inner = parseJsonObject(parsed.body);
  if (!hasErrorStatus && inner?.success !== false) return null;

  const statusCode = typeof parsed.statusCode === 'string' ? parsed.statusCode : '';
  const innerMessage = typeof inner?.message === 'string' ? inner.message : '';
  const innerDetails = typeof inner?.details === 'string' ? inner.details : '';
  const innerCode = typeof inner?.code === 'string' ? inner.code : '';
  const innerType = typeof inner?.type === 'string' ? inner.type : '';
  const outerMessage = typeof parsed.message === 'string' ? parsed.message : '';
  const bodyText = typeof parsed.body === 'string' ? parsed.body : '';
  const message = innerMessage || outerMessage || bodyText || statusCode || `HTTP ${statusValue}`;
  return {
    type: innerType || innerCode || statusCode || 'provider_stream_error',
    message: innerDetails ? `${message}: ${innerDetails}` : message,
  };
}

function extractProviderTopLevelError(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  const code = parsed.code != null ? String(parsed.code) : '';
  const details = typeof parsed.details === 'string' ? parsed.details : '';
  const messageField = parsed.message;
  const nestedQueue = messageField && typeof messageField === 'object' && !Array.isArray(messageField)
    ? messageField
    : null;
  const message = typeof messageField === 'string'
    ? messageField
    : nestedQueue
      ? JSON.stringify(messageField)
      : '';
  const isQueued = nestedQueue?.isQueued === true
    || nestedQueue?.queued === true
    || code === '10605'
    || /isQueued["']?\s*:\s*true/i.test(message);
  if (!message && !isQueued) return null;
  if (
    !isQueued
    && parsed.success !== false
    && !type.toLowerCase().includes('error')
    && !code.toLowerCase().includes('error')
    && code !== '10605'
  ) return null;
  return {
    type: type || code || (isQueued ? '10605' : 'provider_stream_error'),
    message: details
      ? `${message || code}: ${details}`
      : (message || (isQueued ? JSON.stringify({ code: code || '10605', message: nestedQueue }) : code)),
  };
}

/** Default SSE idle timeout for OpenAI-compatible chat streams (Grok etc.). */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;

function streamIdleTimeoutError(ms) {
  const error = new Error(`provider_stream_idle_timeout: no SSE data received for ${ms}ms`);
  error.type = 'provider_stream_idle_timeout';
  return error;
}

async function readStreamChunk(reader, signal, idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS) {
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

function unwrapProviderStreamEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (typeof parsed.body !== 'string') return parsed;
  try {
    const inner = JSON.parse(parsed.body);
    if (
      inner && typeof inner === 'object' &&
      (Array.isArray(inner.choices) || inner.error || inner.usage || inner.type)
    ) {
      return inner;
    }
  } catch {}
  return parsed;
}

function normalizeStreamToolCalls(toolCalls) {
  return toolCalls
    .filter(Boolean)
    .map((tc) => ({
      id: tc.id || '',
      name: tc.name || '',
      arguments: tc.arguments || '',
    }));
}

function extractCachedPromptTokens(usage) {
  return usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_cache_hit
    ?? usage?.input_tokens_details?.cached_tokens
    ?? 0;
}

function consumeOpenAIStreamLine(line, state, webContents, streamId, trace = null, options = {}) {
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
    const parsedEnvelope = JSON.parse(payload);
    const envelopeError = extractProviderEnvelopeError(parsedEnvelope);
    const parsed = envelopeError
      ? { type: 'error', error: { type: envelopeError.type, message: envelopeError.message } }
      : unwrapProviderStreamEnvelope(parsedEnvelope);
    trace?.recordSsePayload?.(payload, parsed);
    const streamError = envelopeError || extractOpenAIStreamError(parsed) || extractProviderTopLevelError(parsed);
    if (streamError) {
      state.streamError = streamError;
      return;
    }
    if (parsed.type === 'content_block_start') {
      if (parsed.content_block?.type === 'tool_use') {
        state.currentAnthropicToolIndex = state.toolCalls.length;
        state.toolCalls.push({
          id: parsed.content_block.id || '',
          name: parsed.content_block.name || '',
          arguments: '',
        });
      } else {
        state.currentAnthropicToolIndex = -1;
      }
      return;
    }
    if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        state.content += parsed.delta.text;
        if (!options.bufferTextDeltas) {
          webContents.send('chat:stream:delta', { streamId, content: parsed.delta.text });
        }
      } else if (parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
        state.thinkingContent += parsed.delta.thinking;
        if (!options.bufferThinkingDeltas) {
          webContents.send('chat:stream:thinking', { streamId, content: parsed.delta.thinking });
        }
      } else if (parsed.delta?.type === 'input_json_delta' && state.currentAnthropicToolIndex >= 0) {
        const entry = state.toolCalls[state.currentAnthropicToolIndex];
        if (entry) {
          entry.arguments += parsed.delta.partial_json || '';
          emitToolArgProgress(entry, {
            webContents,
            streamId,
            toolCallId: entry.id,
            toolName: entry.name,
            argsJson: entry.arguments,
          });
        }
      }
      return;
    }
    if (parsed.type === 'content_block_stop') {
      state.currentAnthropicToolIndex = -1;
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    const contentDelta = extractTextLikeDelta(delta?.content);
    if (contentDelta) {
      state.content += contentDelta;
      if (!options.bufferTextDeltas) {
        webContents.send('chat:stream:delta', { streamId, content: contentDelta });
      }
    }
    const reasoningDelta = extractOpenAIReasoningDelta(delta);
    if (reasoningDelta) {
      state.thinkingContent += reasoningDelta;
      if (!options.bufferThinkingDeltas) {
        webContents.send('chat:stream:thinking', { streamId, content: reasoningDelta });
      }
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!state.toolCalls[tc.index]) state.toolCalls[tc.index] = { id: '', name: '', arguments: '' };
        const entry = state.toolCalls[tc.index];
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name = tc.function.name;
        if (tc.function?.arguments) {
          entry.arguments += tc.function.arguments;
          emitToolArgProgress(entry, {
            webContents,
            streamId,
            toolCallId: entry.id,
            toolName: entry.name,
            argsJson: entry.arguments,
          });
        }
      }
    }
    if (parsed.usage) {
      const u = parsed.usage;
      const cachedTokens = extractCachedPromptTokens(u);
      const promptTokens = u.prompt_tokens ?? 0;
      state.usage = {
        // OpenAI-compatible prompt_tokens 已包含 cached_tokens。内部账本约定
        // inputTokens 与 cacheReadTokens 互斥，避免显示层 input + cacheRead 重复计数。
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        outputTokens: u.completion_tokens ?? 0,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
      };
      webContents.send('chat:stream:usage', { streamId, usage: state.usage });
    }
  } catch (error) {
    trace?.recordParseError?.(payload, error);
    /* skip malformed stream frame */
  }
}

export async function consumeOpenAIStream(res, webContents, streamId, trace = null, signal = null, options = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReading = false;
  const state = {
    content: '',
    thinkingContent: '',
    toolCalls: [],
    currentAnthropicToolIndex: -1,
    usage: null,
    streamError: null,
  };

  while (true) {
    await throwIfSseReaderAborted(signal, reader);
    let chunk;
    try {
      chunk = await readStreamChunk(
        reader,
        signal,
        options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      );
    } catch (error) {
      state.streamError = {
        type: error?.type || error?.name || 'provider_stream_error',
        message: error?.message || String(error),
      };
      break;
    }
    const { done, value } = chunk;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeOpenAIStreamLine(line, state, webContents, streamId, trace, options);
      if (state.streamError) {
        stopReading = true;
        break;
      }
      await throwIfSseReaderAborted(signal, reader);
    }
    if (stopReading) {
      try {
        await reader.cancel(state.streamError);
      } catch {
        /* stream may already be closed */
      }
      break;
    }
  }
  await throwIfSseReaderAborted(signal, reader);
  if (!state.streamError && buffer.trim()) consumeOpenAIStreamLine(buffer, state, webContents, streamId, trace, options);

  // Buffered streams may receive reasoning after final text from Qoder-compatible
  // APIs. Emit the accumulated thinking first so the renderer never has to show
  // a final answer before its reasoning block arrives.
  const canEmitBufferedThinking =
    state.content.trim() || state.toolCalls.filter(Boolean).length > 0;
  if (
    options.bufferThinkingDeltas &&
    options.emitBufferedThinkingDeltas !== false &&
    state.thinkingContent &&
    canEmitBufferedThinking &&
    !hasLiteralToolCallSyntax(state.thinkingContent)
  ) {
    webContents.send('chat:stream:thinking', { streamId, content: state.thinkingContent });
  }
  if (options.bufferTextDeltas && state.content && !hasLiteralToolCallSyntax(state.content)) {
    webContents.send('chat:stream:delta', { streamId, content: state.content });
  }

  return {
    content: state.content,
    thinkingContent: state.thinkingContent,
    toolCalls: normalizeStreamToolCalls(state.toolCalls),
    streamUsage: state.usage,
    streamError: state.streamError,
  };
}

export async function sendOpenAIChatStream({
  baseUrl,
  apiKey,
  endpoint,
  headers,
  model,
  messages,
  tools,
  effort,
  supportsReasoning,
  reasoningParamStyle = 'openai-effort',
  promptCaching = false,
  maxOutputTokens,
  reasoningEffortMap,
  signal,
  webContents,
  streamId,
  usePublicStreamConsumer = false,
}) {
  const url = endpoint || `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = encodeOpenAIChatRequest({
    model,
    messages,
    tools,
    effort,
    supportsReasoning,
    reasoningParamStyle,
    promptCaching,
    maxOutputTokens,
    reasoningEffortMap,
  });
  const trace = createProviderStreamTrace({
    provider: 'openai',
    baseUrl,
    model,
    effort,
    supportsReasoning,
    streamId,
    requestBody: body,
  });

  const res = await fetchWithConnectionRecovery(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  }, {
    webContents,
    streamId,
    provider: 'openai',
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
    if (tracePath) console.warn(`[provider-trace] wrote OpenAI HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: body.messages,
      providerTracePath: tracePath,
    };
  }

  const publicToolCalls = new Map();
  const streamResult = usePublicStreamConsumer
    ? await consumeOpenAIChatStream({
        response: res,
        providerId: 'openai',
        signal,
        malformedPayload: 'ignore',
        streamErrorMode: 'return',
        onPayload: (payload, parsed) => trace.recordSsePayload?.(payload, parsed),
        onMalformedPayload: (payload, error) => trace.recordParseError?.(payload, error),
        onIgnoredLine: (line) => trace.recordIgnoredLine?.(line),
        onDone: () => trace.recordDoneMarker?.(),
        onEvent: (event) => {
          if (event.type === 'text.delta') {
            webContents.send('chat:stream:delta', { streamId, content: event.content });
            return;
          }
          if (event.type === 'reasoning.delta') {
            webContents.send('chat:stream:thinking', { streamId, content: event.content });
            return;
          }
          if (event.type === 'tool_call.delta') {
            const call = publicToolCalls.get(event.index) ?? { id: '', name: '', arguments: '' };
            if (event.id) call.id = event.id;
            if (event.name) call.name += event.name;
            if (event.arguments) call.arguments += event.arguments;
            publicToolCalls.set(event.index, call);
            if (event.arguments) {
              emitToolArgProgress(call, {
                webContents,
                streamId,
                toolCallId: call.id,
                toolName: call.name,
                argsJson: call.arguments,
              });
            }
            return;
          }
          if (event.type === 'usage') {
            webContents.send('chat:stream:usage', { streamId, usage: event.usage });
          }
        },
      }).then((result) => ({
        content: result.content,
        thinkingContent: result.reasoningContent ?? '',
        toolCalls: result.toolCalls,
        streamUsage: result.usage ?? null,
        streamError: result.streamError ?? null,
      }))
    : await consumeOpenAIStream(res, webContents, streamId, trace, signal);
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
    if (tracePath) console.warn(`[provider-trace] wrote OpenAI stream error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      providerError: true,
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
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote OpenAI empty stream trace: ${tracePath}`);

  return {
    ok: true,
    messages: body.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}
