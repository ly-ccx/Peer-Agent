import { encodeGeminiGenerateContentRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { parseSseDataPayload } from './sse-line.mjs';

function extractGeminiStreamError(parsed) {
  const error = parsed?.error;
  if (!error) return null;
  return {
    type: error.status || error.code || 'provider_stream_error',
    message: error.message || JSON.stringify(error),
  };
}

function normalizeGeminiUsage(usage) {
  if (!usage) return null;
  return {
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    cacheReadTokens: usage.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
  };
}

function consumeGeminiPayload(parsed, state, webContents, streamId, trace = null) {
  trace?.recordSsePayload?.(JSON.stringify(parsed), parsed);
  const streamError = extractGeminiStreamError(parsed);
  if (streamError) {
    state.streamError = streamError;
    return;
  }
  const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text) {
        state.content += part.text;
        webContents.send('chat:stream:delta', { streamId, content: part.text });
      }
      if (part.functionCall?.name) {
        const toolCall = {
          id: `gemini_call_${state.toolCalls.length + 1}`,
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        };
        state.toolCalls.push(toolCall);
        emitToolArgProgress(toolCall, {
          webContents,
          streamId,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          argsJson: toolCall.arguments,
        });
      }
    }
  }
  const usage = normalizeGeminiUsage(parsed?.usageMetadata);
  if (usage) {
    state.usage = usage;
    webContents.send('chat:stream:usage', { streamId, usage });
  }
}

function consumeGeminiStreamLine(line, state, webContents, streamId, trace = null) {
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
    consumeGeminiPayload(JSON.parse(payload), state, webContents, streamId, trace);
  } catch (error) {
    trace?.recordParseError?.(payload, error);
  }
}

async function consumeGeminiStream(res, webContents, streamId, trace = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    content: '',
    thinkingContent: '',
    toolCalls: [],
    usage: null,
    streamError: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consumeGeminiStreamLine(line, state, webContents, streamId, trace);
  }
  if (buffer.trim()) consumeGeminiStreamLine(buffer, state, webContents, streamId, trace);
  return {
    content: state.content,
    thinkingContent: state.thinkingContent,
    toolCalls: state.toolCalls,
    streamUsage: state.usage,
    streamError: state.streamError,
  };
}

export async function sendGeminiStream({
  baseUrl,
  endpoint,
  headers,
  model,
  messages,
  tools,
  effort,
  supportsReasoning,
  maxOutputTokens,
  signal,
  webContents,
  streamId,
}) {
  const url = endpoint || `${baseUrl.replace(/\/+$/, '')}/models/${model}:streamGenerateContent?alt=sse`;
  const body = encodeGeminiGenerateContentRequest({ messages, tools, maxOutputTokens });
  const trace = createProviderStreamTrace({
    provider: 'gemini',
    baseUrl,
    model,
    effort,
    supportsReasoning,
    streamId,
    requestBody: body,
  });

  const res = await fetchWithConnectionRecovery(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  }, {
    webContents,
    streamId,
    provider: 'gemini',
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
    if (tracePath) console.warn(`[provider-trace] wrote Gemini HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeGeminiStream(res, webContents, streamId, trace);
  if (streamResult.streamError) {
    const errorText = `provider_stream_error: ${streamResult.streamError.message}`;
    const tracePath = await trace.finish({
      anomaly: 'provider_stream_error',
      httpError: errorText,
      result: { ok: false, status: res.status, streamErrorType: streamResult.streamError.type },
    });
    return {
      ok: false,
      status: res.status,
      errorText,
      providerError: true,
      messages,
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
      toolCallCount: streamResult.toolCalls.length,
      hasUsage: Boolean(streamResult.streamUsage),
    },
  });
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote Gemini empty stream trace: ${tracePath}`);

  return {
    ok: true,
    messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}
