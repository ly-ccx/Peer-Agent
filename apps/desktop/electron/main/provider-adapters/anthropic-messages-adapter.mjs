import { encodeAnthropicMessagesRequest } from '../provider-encoders/index.mjs';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';

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

const TOOL_ARG_PROGRESS_INTERVAL_MS = 120;

// 工具调用参数(尤其 edit_file/write_file 的整文件内容)以 input_json_delta 流式抵达，
// 在 content_block_stop 之前对 renderer 完全不可见，长编辑会表现为“一直等待中”。
// 这里在参数累积期间发出节流的 tool-progress 事件，给用户 Codex 式的实时体感。
// 注意:这是 provider 适配层的“流式进度提示”，不替代真正的 Tool Result / Evidence,
// 仅由后续 chat:stream:tool-call 与本地能力执行结果接管事实。
function emitToolArgProgress(block, webContents, streamId) {
  if (!block || !webContents) return;
  const json = block.inputJson || '';
  // 路径在 JSON 前部即可解析出来,先于整段内容到达。
  if (block.argPath === undefined) {
    const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
    if (match) {
      try {
        block.argPath = JSON.parse(`"${match[1]}"`);
      } catch {
        block.argPath = match[1];
      }
    }
  }
  // JSON 转义后的换行表现为字面量 \n,据此估算“已接收行数”。
  const receivedLines = (json.match(/\\n/g) || []).length;
  const now = Date.now();
  if (
    block.lastProgressAt &&
    now - block.lastProgressAt < TOOL_ARG_PROGRESS_INTERVAL_MS &&
    receivedLines === block.lastProgressLines
  ) {
    return;
  }
  block.lastProgressAt = now;
  block.lastProgressLines = receivedLines;
  webContents.send('chat:stream:tool-progress', {
    streamId,
    toolCallId: block.id,
    tool: block.name,
    path: block.argPath ?? null,
    receivedChars: json.length,
    receivedLines,
  });
}

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
        emitToolArgProgress(block, webContents, streamId);
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
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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
