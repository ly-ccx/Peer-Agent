import { encodeOpenAIChatRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { parseSseDataPayload, throwIfSseReaderAborted } from './sse-line.mjs';

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
  return {
    type: error.type || error.code || 'provider_stream_error',
    message: error.message || JSON.stringify(error),
  };
}

function extractCachedPromptTokens(usage) {
  return usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? usage?.prompt_cache_hit
    ?? usage?.input_tokens_details?.cached_tokens
    ?? 0;
}

function consumeOpenAIStreamLine(line, state, webContents, streamId, trace = null) {
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
    const streamError = extractOpenAIStreamError(parsed);
    if (streamError) {
      state.streamError = streamError;
      return;
    }
    const delta = parsed.choices?.[0]?.delta;
    const contentDelta = extractTextLikeDelta(delta?.content);
    if (contentDelta) {
      state.content += contentDelta;
      webContents.send('chat:stream:delta', { streamId, content: contentDelta });
    }
    const reasoningDelta = extractOpenAIReasoningDelta(delta);
    if (reasoningDelta) {
      state.thinkingContent += reasoningDelta;
      webContents.send('chat:stream:thinking', { streamId, content: reasoningDelta });
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
      state.usage = {
        inputTokens: u.prompt_tokens ?? 0,
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

async function consumeOpenAIStream(res, webContents, streamId, trace = null, signal = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = { content: '', thinkingContent: '', toolCalls: [], usage: null, streamError: null };

  while (true) {
    await throwIfSseReaderAborted(signal, reader);
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeOpenAIStreamLine(line, state, webContents, streamId, trace);
      await throwIfSseReaderAborted(signal, reader);
    }
  }
  await throwIfSseReaderAborted(signal, reader);
  if (buffer.trim()) consumeOpenAIStreamLine(buffer, state, webContents, streamId, trace);

  return {
    content: state.content,
    thinkingContent: state.thinkingContent,
    toolCalls: state.toolCalls.filter(Boolean),
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

  const streamResult = await consumeOpenAIStream(res, webContents, streamId, trace, signal);
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
