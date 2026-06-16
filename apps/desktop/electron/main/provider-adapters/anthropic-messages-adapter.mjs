import { encodeAnthropicMessagesRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { emitToolArgProgress } from './tool-arg-progress.mjs';
import { buildClaudeCliIdentityHeaders } from './anthropic-cli-identity.mjs';

function resolveAnthropicReasoningFormat(baseUrl) {
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'idealab.alibaba-inc.com' && url.pathname.includes('/api/anthropic')) {
      return 'adaptive';
    }
  } catch {
    /* fall through */
  }
  return 'enabled';
}

function parseNestedProviderErrorMessage(message) {
  if (typeof message !== 'string' || !message.trim()) return '';
  try {
    const parsed = JSON.parse(message);
    return parsed?.error?.message || parsed?.message || message;
  } catch {
    return message;
  }
}

function extractAnthropicStreamError(parsed) {
  if (parsed?.type !== 'error' && !parsed?.error) return null;
  const error = parsed?.error ?? parsed;
  const rawMessage = error?.message || parsed?.message || JSON.stringify(error);
  return {
    type: error?.type || parsed?.type || 'provider_stream_error',
    message: parseNestedProviderErrorMessage(rawMessage),
  };
}

// 工具参数流式进度（emitToolArgProgress）已抽取到共享模块 ./tool-arg-progress.mjs，
// 三个 provider 适配器复用同一“解析 path / 估算行数 / 节流 / 发送”逻辑。

function consumeAnthropicStreamLine(line, state, webContents, streamId, trace = null) {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith('data: ')) {
    trace?.recordIgnoredLine?.(trimmed);
    return;
  }
  const payload = trimmed.slice(6);
  if (payload === '[DONE]') {
    trace?.recordDoneMarker?.();
    return;
  }
  try {
    const parsed = JSON.parse(payload);
    trace?.recordSsePayload?.(payload, parsed);
    const streamError = extractAnthropicStreamError(parsed);
    if (streamError) {
      state.streamError = streamError;
      return;
    }
    if (parsed.type === 'content_block_start') {
      if (parsed.content_block?.type === 'tool_use') {
        state.currentToolIndex = state.toolUseBlocks.length;
        state.toolUseBlocks.push({ id: parsed.content_block.id, name: parsed.content_block.name, inputJson: '' });
      } else if (parsed.content_block?.type === 'thinking') {
        state.currentToolIndex = -1;
        state.inThinking = true;
      } else {
        state.currentToolIndex = -1;
        state.inThinking = false;
      }
    } else if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        state.textContent += parsed.delta.text;
        webContents.send('chat:stream:delta', { streamId, content: parsed.delta.text });
      } else if (parsed.delta?.type === 'thinking_delta' && parsed.delta.thinking) {
        // 深度模式: Anthropic 先流式发送 thinking 内容。收集它并单独推给渲染层，
        // 同时纳入“非空响应”判定，避免被误判为 empty_model_response。
        state.thinkingContent += parsed.delta.thinking;
        webContents.send('chat:stream:thinking', { streamId, content: parsed.delta.thinking });
      } else if (parsed.delta?.type === 'signature_delta' && parsed.delta.signature) {
        // thinking block 的签名，多轮回传时 Anthropic 要求带上。
        state.thinkingSignature += parsed.delta.signature;
      } else if (parsed.delta?.type === 'input_json_delta' && state.currentToolIndex >= 0) {
        const block = state.toolUseBlocks[state.currentToolIndex];
        block.inputJson += parsed.delta.partial_json;
        emitToolArgProgress(block, {
          webContents,
          streamId,
          toolCallId: block.id,
          toolName: block.name,
          argsJson: block.inputJson,
        });
      }
    } else if (parsed.type === 'content_block_stop') {
      state.inThinking = false;
    } else if (parsed.type === 'message_delta') {
      if (parsed.delta?.stop_reason) state.stopReason = parsed.delta.stop_reason;
      if (parsed.usage) {
        state.usage = { ...(state.usage || {}), outputTokens: parsed.usage.output_tokens ?? 0 };
        webContents.send('chat:stream:usage', { streamId, usage: state.usage });
      }
    } else if (parsed.type === 'message_start' && parsed.message?.usage) {
      const u = parsed.message.usage;
      state.usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
      };
      webContents.send('chat:stream:usage', { streamId, usage: state.usage });
    }
  } catch (error) {
    trace?.recordParseError?.(payload, error);
    /* skip malformed stream frame */
  }
}

async function consumeAnthropicStream(res, webContents, streamId, trace = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    textContent: '',
    thinkingContent: '',
    thinkingSignature: '',
    inThinking: false,
    toolUseBlocks: [],
    currentToolIndex: -1,
    stopReason: null,
    usage: null,
    streamError: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeAnthropicStreamLine(line, state, webContents, streamId, trace);
    }
  }
  if (buffer.trim()) consumeAnthropicStreamLine(buffer, state, webContents, streamId, trace);

  return {
    textContent: state.textContent,
    thinkingContent: state.thinkingContent,
    thinkingSignature: state.thinkingSignature,
    toolUseBlocks: state.toolUseBlocks,
    stopReason: state.stopReason,
    streamUsage: state.usage,
    streamError: state.streamError,
  };
}

export async function sendAnthropicMessagesStream({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  tools,
  effort,
  supportsReasoning,
  signal,
  webContents,
  streamId,
  reasoningFormat = resolveAnthropicReasoningFormat(baseUrl),
  promptCaching = false,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const body = encodeAnthropicMessagesRequest({
    model,
    system,
    messages,
    tools,
    effort,
    supportsReasoning,
    reasoningFormat,
    promptCaching,
  });
  const trace = createProviderStreamTrace({
    provider: 'anthropic',
    baseUrl,
    model,
    effort,
    supportsReasoning,
    streamId,
    requestBody: body,
  });

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
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    if (tracePath) console.warn(`[provider-trace] wrote Anthropic HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: body.messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeAnthropicStream(res, webContents, streamId, trace);
  if (streamResult.streamError) {
    const errorText = `provider_stream_error: ${streamResult.streamError.message}`;
    const tracePath = await trace.finish({
      anomaly: 'provider_stream_error',
      httpError: errorText,
      result: {
        ok: false,
        status: res.status,
        streamErrorType: streamResult.streamError.type,
        textChars: streamResult.textContent.length,
        thinkingChars: streamResult.thinkingContent.length,
        toolUseCount: streamResult.toolUseBlocks.length,
      },
    });
    if (tracePath) console.warn(`[provider-trace] wrote Anthropic stream error trace: ${tracePath}`);
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
    !String(streamResult.textContent || '').trim() &&
    !String(streamResult.thinkingContent || '').trim() &&
    !streamResult.toolUseBlocks.length
      ? 'empty_stream_result'
      : null;
  const tracePath = await trace.finish({
    anomaly,
    result: {
      ok: true,
      status: res.status,
      textChars: streamResult.textContent.length,
      thinkingChars: streamResult.thinkingContent.length,
      thinkingSignatureChars: streamResult.thinkingSignature.length,
      toolUseCount: streamResult.toolUseBlocks.length,
      stopReason: streamResult.stopReason,
      hasUsage: Boolean(streamResult.streamUsage),
    },
  });
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote Anthropic empty stream trace: ${tracePath}`);

  return {
    ok: true,
    messages: body.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}
