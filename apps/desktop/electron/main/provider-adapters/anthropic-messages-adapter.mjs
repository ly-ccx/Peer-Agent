import { encodeAnthropicMessagesRequest } from '../provider-encoders/index.mjs';

function consumeAnthropicStreamLine(line, state, webContents, streamId) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  try {
    const parsed = JSON.parse(trimmed.slice(6));
    if (parsed.type === 'content_block_start') {
      if (parsed.content_block?.type === 'tool_use') {
        state.currentToolIndex = state.toolUseBlocks.length;
        state.toolUseBlocks.push({ id: parsed.content_block.id, name: parsed.content_block.name, inputJson: '' });
      } else {
        state.currentToolIndex = -1;
      }
    } else if (parsed.type === 'content_block_delta') {
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        state.textContent += parsed.delta.text;
        webContents.send('chat:stream:delta', { streamId, content: parsed.delta.text });
      } else if (parsed.delta?.type === 'input_json_delta' && state.currentToolIndex >= 0) {
        state.toolUseBlocks[state.currentToolIndex].inputJson += parsed.delta.partial_json;
      }
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
  } catch {
    /* skip malformed stream frame */
  }
}

async function consumeAnthropicStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    textContent: '',
    toolUseBlocks: [],
    currentToolIndex: -1,
    stopReason: null,
    usage: null,
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeAnthropicStreamLine(line, state, webContents, streamId);
    }
  }
  if (buffer.trim()) consumeAnthropicStreamLine(buffer, state, webContents, streamId);

  return {
    textContent: state.textContent,
    toolUseBlocks: state.toolUseBlocks,
    stopReason: state.stopReason,
    streamUsage: state.usage,
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
  signal,
  webContents,
  streamId,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const body = encodeAnthropicMessagesRequest({
    model,
    system,
    messages,
    tools,
    effort,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      errorText: await res.text().catch(() => ''),
      messages: body.messages,
    };
  }

  return {
    ok: true,
    messages: body.messages,
    ...(await consumeAnthropicStream(res, webContents, streamId)),
  };
}
