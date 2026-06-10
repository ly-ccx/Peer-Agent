import { encodeOpenAIChatRequest } from '../provider-encoders/index.mjs';

function consumeOpenAIStreamLine(line, state, webContents, streamId) {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('data: ')) return;
  const payload = trimmed.slice(6);
  if (payload === '[DONE]') return;
  try {
    const parsed = JSON.parse(payload);
    const delta = parsed.choices?.[0]?.delta;
    if (delta?.content) {
      state.content += delta.content;
      webContents.send('chat:stream:delta', { streamId, content: delta.content });
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (!state.toolCalls[tc.index]) state.toolCalls[tc.index] = { id: '', name: '', arguments: '' };
        if (tc.id) state.toolCalls[tc.index].id = tc.id;
        if (tc.function?.name) state.toolCalls[tc.index].name = tc.function.name;
        if (tc.function?.arguments) state.toolCalls[tc.index].arguments += tc.function.arguments;
      }
    }
    if (parsed.usage) {
      const u = parsed.usage;
      const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
      state.usage = {
        inputTokens: u.prompt_tokens ?? 0,
        outputTokens: u.completion_tokens ?? 0,
        cacheReadTokens: cachedTokens,
        cacheWriteTokens: 0,
      };
      webContents.send('chat:stream:usage', { streamId, usage: state.usage });
    }
  } catch {
    /* skip malformed stream frame */
  }
}

async function consumeOpenAIStream(res, webContents, streamId) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = { content: '', toolCalls: [], usage: null };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      consumeOpenAIStreamLine(line, state, webContents, streamId);
    }
  }
  if (buffer.trim()) consumeOpenAIStreamLine(buffer, state, webContents, streamId);

  return {
    content: state.content,
    toolCalls: state.toolCalls.filter(Boolean),
    streamUsage: state.usage,
  };
}

export async function sendOpenAIChatStream({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  effort,
  signal,
  webContents,
  streamId,
}) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = encodeOpenAIChatRequest({
    model,
    messages,
    tools,
    effort,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
    ...(await consumeOpenAIStream(res, webContents, streamId)),
  };
}
