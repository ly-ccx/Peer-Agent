import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_EVENTS = 200;
const MAX_PREVIEW_CHARS = 600;

function nowIso() {
  return new Date().toISOString();
}

function safeUrlSummary(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return {
      origin: url.origin,
      pathname: url.pathname || '/',
    };
  } catch {
    return { origin: 'invalid_url', pathname: '' };
  }
}

function countBlocks(messages, predicate) {
  if (!Array.isArray(messages)) return 0;
  let count = 0;
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (predicate(block)) count += 1;
    }
  }
  return count;
}

function countSystemCacheBlocks(system) {
  if (!Array.isArray(system)) return 0;
  return system.filter((block) => block?.cache_control).length;
}

function summarizeRequestBody(body) {
  // Gemini Code Assist envelope: { model, project, request: { contents, ... } }
  const caContents = Array.isArray(body?.request?.contents) ? body.request.contents : null;
  const messages = Array.isArray(body?.messages)
    ? body.messages
    : (caContents || []);
  return {
    model: body?.model ?? null,
    project: body?.project ?? null,
    stream: Boolean(body?.stream),
    maxTokens: body?.max_tokens ?? body?.max_completion_tokens ?? body?.request?.generationConfig?.maxOutputTokens ?? null,
    hasThinking: Boolean(body?.thinking),
    thinking: body?.thinking
      ? {
          type: body.thinking.type ?? null,
          budgetTokens: body.thinking.budget_tokens ?? null,
        }
      : null,
    outputConfigEffort: body?.output_config?.effort ?? null,
    hasReasoningEffort: Boolean(body?.reasoning_effort),
    reasoningEffort: body?.reasoning_effort ?? null,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    messageCount: messages.length,
    systemShape: typeof body?.system,
    systemBlockCount: Array.isArray(body?.system) ? body.system.length : 0,
    systemCacheBlockCount: countSystemCacheBlocks(body?.system),
    textBlockCount: countBlocks(messages, (block) => block?.type === 'text'),
    imageBlockCount: countBlocks(messages, (block) => block?.type === 'image'),
    toolUseBlockCount: countBlocks(messages, (block) => block?.type === 'tool_use'),
    toolResultBlockCount: countBlocks(messages, (block) => block?.type === 'tool_result'),
    cacheBlockCount: countBlocks(messages, (block) => Boolean(block?.cache_control)),
  };
}

function truncate(value, maxChars = MAX_PREVIEW_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...<truncated ${text.length - maxChars} chars>`;
}

function summarizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? null,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? null,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? null,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? null,
  };
}

function summarizeAnthropicFrame(parsed) {
  const delta = parsed?.delta;
  const contentBlock = parsed?.content_block;
  return {
    type: parsed?.type ?? null,
    contentBlockType: contentBlock?.type ?? null,
    deltaType: delta?.type ?? null,
    stopReason: parsed?.delta?.stop_reason ?? null,
    messageStopReason: parsed?.message?.stop_reason ?? null,
    textChars: typeof delta?.text === 'string' ? delta.text.length : 0,
    thinkingChars: typeof delta?.thinking === 'string' ? delta.thinking.length : 0,
    signatureChars: typeof delta?.signature === 'string' ? delta.signature.length : 0,
    partialJsonChars: typeof delta?.partial_json === 'string' ? delta.partial_json.length : 0,
    hasError: parsed?.type === 'error' || Boolean(parsed?.error),
    errorType: parsed?.error?.type ?? null,
    errorMessagePreview: parsed?.error?.message ? truncate(parsed.error.message, 240) : null,
    usage: summarizeUsage(parsed?.usage ?? parsed?.message?.usage),
    keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : [],
  };
}

function summarizeOpenAIFrame(parsed) {
  const choice = parsed?.choices?.[0];
  const delta = choice?.delta;
  return {
    object: parsed?.object ?? null,
    choiceCount: Array.isArray(parsed?.choices) ? parsed.choices.length : 0,
    finishReason: choice?.finish_reason ?? null,
    deltaKeys: delta && typeof delta === 'object' ? Object.keys(delta).sort() : [],
    contentChars: typeof delta?.content === 'string' ? delta.content.length : 0,
    reasoningChars: typeof delta?.reasoning_content === 'string' ? delta.reasoning_content.length : 0,
    hasToolCalls: Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0,
    usage: parsed?.usage
      ? {
          promptTokens: parsed.usage.prompt_tokens ?? null,
          completionTokens: parsed.usage.completion_tokens ?? null,
          cachedTokens: parsed.usage.prompt_tokens_details?.cached_tokens ?? null,
        }
      : null,
    keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : [],
  };
}

function summarizeOpenAIResponsesFrame(parsed) {
  const delta = typeof parsed?.delta === 'string' ? parsed.delta : '';
  return {
    type: parsed?.type ?? null,
    itemType: parsed?.item?.type ?? null,
    deltaChars: delta.length,
    hasDelta: delta.length > 0,
    usage: summarizeUsage(parsed?.response?.usage ?? parsed?.usage),
    keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).sort() : [],
  };
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function traceDir() {
  return path.join(process.env.PEER_AGENT_HOME || path.join(os.homedir(), '.peer-agent'), 'provider-traces');
}

async function appendTrace(record) {
  const dir = traceDir();
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${todayKey()}.jsonl`);
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
  return filePath;
}

function shouldPersistTrace({ anomaly, httpError }) {
  if (process.env.PEER_AGENT_PROVIDER_TRACE === '0') return false;
  return Boolean(
    anomaly ||
    httpError ||
    process.env.PEER_AGENT_PROVIDER_TRACE === '1'
  );
}

export function createProviderStreamTrace({
  provider,
  baseUrl,
  endpoint = null,
  wire = null,
  channelId = null,
  modelProviderId = null,
  model,
  effort,
  supportsReasoning,
  streamId,
  requestBody,
}) {
  const startedAt = nowIso();
  const record = {
    schemaVersion: 1,
    kind: 'provider_stream_trace',
    provider,
    streamId,
    startedAt,
    endedAt: null,
    baseUrl: safeUrlSummary(baseUrl),
    endpoint: endpoint ? safeUrlSummary(endpoint) : null,
    wire,
    channelId,
    modelProviderId,
    model,
    effort,
    supportsReasoning: Boolean(supportsReasoning),
    request: summarizeRequestBody(requestBody),
    response: {
      status: null,
      ok: null,
      headers: {},
    },
    events: [],
    parseErrors: [],
    result: null,
    anomaly: null,
    httpError: null,
  };

  function pushEvent(event) {
    if (record.events.length >= MAX_EVENTS) {
      if (record.events.length === MAX_EVENTS) {
        record.events.push({ omitted: true, reason: 'event_limit_reached' });
      }
      return;
    }
    record.events.push({ index: record.events.length, ...event });
  }

  return {
    recordResponse(res) {
      record.response.status = res?.status ?? null;
      record.response.ok = Boolean(res?.ok);
      record.response.headers = {
        contentType: res?.headers?.get?.('content-type') ?? null,
        transferEncoding: res?.headers?.get?.('transfer-encoding') ?? null,
      };
    },
    recordSsePayload(payload, parsed = null) {
      if (provider === 'anthropic') {
        pushEvent({
          frame: 'sse_data',
          rawPreview: truncate(payload),
          summary: parsed ? summarizeAnthropicFrame(parsed) : null,
        });
        return;
      }
      if (provider === 'openai') {
        pushEvent({
          frame: 'sse_data',
          rawPreview: truncate(payload),
          summary: parsed ? summarizeOpenAIFrame(parsed) : null,
        });
        return;
      }
      if (provider === 'openai-responses') {
        pushEvent({
          frame: 'sse_data',
          rawPreview: truncate(payload),
          summary: parsed ? summarizeOpenAIResponsesFrame(parsed) : null,
        });
        return;
      }
      pushEvent({ frame: 'sse_data', rawPreview: truncate(payload) });
    },
    recordIgnoredLine(line) {
      pushEvent({ frame: 'ignored_line', rawPreview: truncate(line, 240) });
    },
    recordDoneMarker() {
      pushEvent({ frame: 'done_marker' });
    },
    recordParseError(payload, error) {
      record.parseErrors.push({
        rawPreview: truncate(payload),
        error: error?.message || String(error),
      });
    },
    async finish({ result, anomaly = null, httpError = null } = {}) {
      record.endedAt = nowIso();
      record.result = result ?? null;
      record.anomaly = anomaly;
      record.httpError = httpError ? truncate(httpError, 1200) : null;
      if (!shouldPersistTrace({ anomaly, httpError })) return null;
      try {
        return await appendTrace(record);
      } catch (error) {
        console.warn('[provider-trace] failed to write trace:', error?.message || error);
        return null;
      }
    },
  };
}
