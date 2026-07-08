import crypto from 'node:crypto';
import { createProviderStreamTrace } from '../provider-diagnostics/provider-trace-recorder.mjs';
import { fetchWithConnectionRecovery } from '../provider-transports/recovering-fetch.mjs';
import { consumeOpenAIStream } from './openai-chat-adapter.mjs';
import { getQoderModelMetadata, listQoderModels } from './qoder-model-catalog.mjs';
import { prepareQoderInferRequest, resolveQoderInferenceEndpoint } from './qoder-local-auth.mjs';

function qoderModelServerHost(env = process.env) {
  const explicit = String(env.QODER_MODEL_SERVER_HOST || '').trim();
  if (explicit) return explicit.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const qoderEnv = String(env.QODER_ENV || env.QODER_ENVIRONMENT || '').trim().toLowerCase();
  if (qoderEnv === 'daily') return 'daily-api2-v2.qoder.sh';
  if (qoderEnv === 'test') return 'test-api2-v2.qoder.sh';
  return 'api2-v2.qoder.sh';
}

export function qoderModelServerBaseUrl(env = process.env) {
  return `https://${qoderModelServerHost(env)}/model/v1`;
}

export function normalizeQoderPreparedEndpoint(endpoint) {
  const raw = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname) return url.origin;
    if (/\/model\/v\d+(?:\/|$)/i.test(pathname)) return null;
    if (/\/chat\/completions(?:\/|$)/i.test(pathname)) return null;
    if (/\/algo\/api\/v\d+\/service\/pro\/sse\/agent_chat_generation(?:\/|$)/i.test(pathname)) return null;
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

export function normalizeQoderModel(model) {
  const raw = String(model || '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return 'auto';
  return raw;
}

function qoderContentPart(part) {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (part.type === 'image_url' && part.image_url?.url) {
    return { type: 'image_url', image_url: { url: part.image_url.url, detail: part.image_url.detail } };
  }
  if (part.type === 'tool_use') {
    const name = typeof part.name === 'string' ? part.name : 'tool';
    const id = typeof part.id === 'string' ? part.id : '';
    const input = part.input && typeof part.input === 'object' ? JSON.stringify(part.input) : '{}';
    return { type: 'text', text: `[tool_use ${name}${id ? ` ${id}` : ''}] ${input}` };
  }
  if (part.type === 'tool_result') {
    const id = typeof part.tool_use_id === 'string' ? part.tool_use_id : '';
    return { type: 'text', text: `[tool_result${id ? ` ${id}` : ''}] ${qoderContentText(part.content)}` };
  }
  if (typeof part.content === 'string') return { type: 'text', text: part.content };
  return null;
}

function qoderContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function qoderToolCallArguments(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      return JSON.stringify(JSON.parse(trimmed));
    } catch {
      return JSON.stringify({ raw_arguments: value });
    }
  }
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '{}';
}

function qoderToolCall(toolCall, index) {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const fn = toolCall.function && typeof toolCall.function === 'object' ? toolCall.function : {};
  const name = typeof fn.name === 'string' && fn.name.trim()
    ? fn.name.trim()
    : typeof toolCall.name === 'string' ? toolCall.name.trim() : '';
  if (!name) return null;
  return {
    id: String(toolCall.id || `qoder_history_tool_${index + 1}`),
    type: 'function',
    function: {
      name,
      arguments: qoderToolCallArguments(fn.arguments ?? toolCall.arguments ?? toolCall.input ?? {}),
    },
  };
}

function qoderMessage(message) {
  const role = String(message?.role || '').trim();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const content = message.content;
  const output = { role };
  if (typeof content === 'string' || content === null) {
    output.content = content;
  } else if (Array.isArray(content)) {
    const parts = content.map(qoderContentPart).filter(Boolean);
    output.content = parts.length ? parts : '';
  } else if (content && typeof content === 'object') {
    const part = qoderContentPart(content);
    output.content = part ? [part] : '';
  } else {
    output.content = '';
  }
  if (message.name) output.name = message.name;
  if (message.tool_call_id) output.tool_call_id = message.tool_call_id;
  if (Array.isArray(message.tool_calls)) {
    const toolCalls = message.tool_calls.map(qoderToolCall).filter(Boolean);
    if (toolCalls.length) output.tool_calls = toolCalls;
  }
  return output;
}

function qoderLastUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) => typeof part === 'string' ? part : part?.text || part?.content || '')
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function qoderPrimitiveType(type) {
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    return type.find((entry) => typeof entry === 'string' && entry !== 'null') || 'string';
  }
  return null;
}

function qoderCompatibleSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object' };
  if (depth > 8) return { type: 'string' };
  const variant = schema.oneOf?.[0] || schema.anyOf?.[0] || schema.allOf?.[0];
  if (!schema.type && variant && typeof variant === 'object') {
    return qoderCompatibleSchema({ ...variant, description: schema.description ?? variant.description }, depth + 1);
  }
  const type = qoderPrimitiveType(schema.type) || (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  const out = { type };
  if (typeof schema.description === 'string' && schema.description.trim()) out.description = schema.description;
  if (Array.isArray(schema.enum)) {
    const enumValues = schema.enum.filter((entry) => {
      if (entry === null) return false;
      if (type === 'integer') return Number.isInteger(entry);
      if (type === 'number') return typeof entry === 'number';
      if (type === 'boolean') return typeof entry === 'boolean';
      return typeof entry === 'string';
    });
    if (enumValues.length) out.enum = enumValues;
  }
  if (type === 'object') {
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties || {})) {
      if (/^[a-zA-Z0-9_.-]+$/.test(key)) properties[key] = qoderCompatibleSchema(value, depth + 1);
    }
    out.properties = properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key))
      : [];
    if (required.length) out.required = required;
    out.additionalProperties = schema.additionalProperties === true ? true : false;
  }
  if (type === 'array') {
    out.items = qoderCompatibleSchema(schema.items || { type: 'string' }, depth + 1);
  }
  return out;
}

function qoderCompatibleTool(tool) {
  if (!tool || typeof tool !== 'object') return null;
  const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return null;
  return {
    type: 'function',
    function: {
      name,
      ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      parameters: qoderCompatibleSchema(fn.parameters || fn.input_schema || { type: 'object' }),
    },
  };
}

function qoderCompatibleTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(qoderCompatibleTool).filter(Boolean);
}

function qoderRemoteChatAsk({
  model,
  messages,
  tools = [],
  maxOutputTokens,
  requestId,
  requestSetId,
  sessionId,
  taskId,
  metadata = null,
} = {}) {
  const normalizedMessages = messages.map(qoderMessage).filter(Boolean);
  const modelKey = metadata?.id || normalizeQoderModel(model);
  const source = metadata?.source || 'system';
  const isReasoning = Boolean(metadata?.supportsReasoning);
  const parameters = {};
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    parameters.max_tokens = Math.trunc(maxOutputTokens);
  }
  return {
    request_id: requestId,
    request_set_id: requestSetId,
    chat_record_id: requestId,
    session_id: sessionId,
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text: qoderLastUserText(normalizedMessages),
      features: [],
      extra: {
        context: [],
        modelConfig: { key: modelKey, is_reasoning: isReasoning },
        originalContent: qoderLastUserText(normalizedMessages),
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: taskId || 'peer-agent',
    session_type: process.env.QODER_SESSION_TYPE || 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: modelKey,
      display_name: metadata?.label || modelKey,
      model: '',
      format: metadata?.format || 'openai',
      is_vl: Boolean(metadata?.supportsVision),
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source,
      max_input_tokens: metadata?.contextWindow || 200000,
    },
    custom_model: null,
    system: normalizedMessages.find((message) => message.role === 'system')?.content || '',
    messages: normalizedMessages,
    tools: qoderCompatibleTools(tools),
    parameters,
  };
}

async function getQoderModelMetadataForSend(model) {
  const syncMetadata = getQoderModelMetadata(model);
  if (syncMetadata) return syncMetadata;
  try {
    const { models } = await listQoderModels();
    const id = String(model || '').trim().toLowerCase();
    return models.find((entry) => entry.id.toLowerCase() === id) || null;
  } catch {
    return null;
  }
}

export function qoderTurnTaskId(streamId) {
  const base = String(streamId || 'peer-agent').trim() || 'peer-agent';
  return `${base}:${crypto.randomUUID()}`;
}

async function sendQoderPreparedStream({
  apiKey,
  model,
  messages,
  tools,
  maxOutputTokens,
  signal,
  webContents,
  streamId,
  endpoint = null,
  bufferThinkingDeltas = false,
  emitBufferedThinkingDeltas = true,
  streamIdleTimeoutMs = 0,
} = {}) {
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const metadata = await getQoderModelMetadataForSend(model);
  const requestBody = qoderRemoteChatAsk({
    model,
    messages,
    tools,
    maxOutputTokens,
    requestId,
    requestSetId: requestId,
    sessionId,
    taskId: qoderTurnTaskId(streamId),
    metadata,
  });
  const resolvedEndpoint = normalizeQoderPreparedEndpoint(endpoint) || await resolveQoderInferenceEndpoint();
  const prepared = await prepareQoderInferRequest({
    requestBody,
    modelKey: requestBody.model_config.key,
    modelSource: requestBody.model_config.source,
    endpoint: resolvedEndpoint,
  });
  const trace = createProviderStreamTrace({
    provider: 'qoder',
    baseUrl: prepared.url || endpoint,
    model: requestBody.model_config.key,
    effort: 'off',
    supportsReasoning: Boolean(requestBody.model_config.is_reasoning),
    streamId,
    requestBody: {
      model: requestBody.model_config.key,
      messages: requestBody.messages,
      tools: requestBody.tools,
      stream: true,
      max_tokens: requestBody.parameters?.max_tokens,
    },
  });

  const headers = {
    ...prepared.headers,
    Accept: prepared.headers.Accept || prepared.headers.accept || 'text/event-stream',
  };
  if (apiKey && !headers.Authorization && !headers.authorization) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const res = await fetchWithConnectionRecovery(prepared.url, {
    method: 'POST',
    headers,
    body: prepared.body,
    signal,
  }, {
    webContents,
    streamId,
    provider: 'qoder',
    model: requestBody.model_config.key,
    retryDelaysMs: [],
    allowSecondaryFallback: false,
  });
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: requestBody.messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeOpenAIStream(res, webContents, streamId, trace, signal, {
    bufferTextDeltas: true,
    bufferThinkingDeltas,
    emitBufferedThinkingDeltas,
    streamIdleTimeoutMs,
  });
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
    return {
      ok: false,
      status: res.status,
      errorText,
      providerError: true,
      messages: requestBody.messages,
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

  return {
    ok: true,
    messages: requestBody.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}

export function buildQoderPrivateRequestBody({
  model,
  messages = [],
  tools = [],
  maxOutputTokens = 0,
  requestId = crypto.randomUUID(),
  requestSetId = requestId,
  sessionId = crypto.randomUUID(),
  taskId = 'peer-agent',
} = {}) {
  const body = {
    model: normalizeQoderModel(model),
    messages: messages.map(qoderMessage).filter(Boolean),
    stream: true,
    stream_options: { include_usage: true },
    tools: qoderCompatibleTools(tools),
    metadata: {
      context: {
        request_id: requestId,
        request_set_id: requestSetId,
        session_id: sessionId,
        task_id: taskId,
        client_type: '5',
      },
    },
  };
  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    body.max_tokens = Math.trunc(maxOutputTokens);
  }
  return body;
}

export function buildQoderPrivateHeaders({ token, requestId, sessionId } = {}) {
  return {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'X-Request-ID': requestId,
    'X-Session-ID': sessionId,
  };
}

export async function sendQoderPrivateStream({
  baseUrl,
  apiKey,
  model,
  messages,
  tools,
  maxOutputTokens,
  signal,
  webContents,
  streamId,
  endpoint = null,
  bufferThinkingDeltas = false,
  emitBufferedThinkingDeltas = true,
  streamIdleTimeoutMs = 0,
} = {}) {
  const metadata = await getQoderModelMetadataForSend(model);
  if (metadata) {
    return sendQoderPreparedStream({
      apiKey,
      model,
      messages,
      tools,
      maxOutputTokens,
      signal,
      webContents,
      streamId,
      endpoint,
      bufferThinkingDeltas,
      emitBufferedThinkingDeltas,
      streamIdleTimeoutMs,
    });
  }
  const requestId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const root = String(baseUrl || qoderModelServerBaseUrl()).replace(/\/+$/, '');
  const url = endpoint || `${root}/chat/completions`;
  const body = buildQoderPrivateRequestBody({
    model,
    messages,
    tools,
    maxOutputTokens,
    requestId,
    requestSetId: requestId,
    sessionId,
    taskId: qoderTurnTaskId(streamId),
  });
  const trace = createProviderStreamTrace({
    provider: 'qoder',
    baseUrl: root,
    model: body.model,
    effort: 'off',
    supportsReasoning: false,
    streamId,
    requestBody: body,
  });

  const res = await fetchWithConnectionRecovery(url, {
    method: 'POST',
    headers: buildQoderPrivateHeaders({ token: apiKey, requestId, sessionId }),
    body: JSON.stringify(body),
    signal,
  }, {
    webContents,
    streamId,
    provider: 'qoder',
    model: body.model,
    retryDelaysMs: [],
    allowSecondaryFallback: false,
  });
  trace.recordResponse(res);

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    const tracePath = await trace.finish({
      anomaly: 'http_error',
      httpError: errorText,
      result: { ok: false, status: res.status },
    });
    if (tracePath) console.warn(`[provider-trace] wrote Qoder HTTP error trace: ${tracePath}`);
    return {
      ok: false,
      status: res.status,
      errorText,
      messages: body.messages,
      providerTracePath: tracePath,
    };
  }

  const streamResult = await consumeOpenAIStream(res, webContents, streamId, trace, signal, {
    bufferTextDeltas: true,
    bufferThinkingDeltas,
    emitBufferedThinkingDeltas,
    streamIdleTimeoutMs,
  });
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
  if (tracePath && anomaly) console.warn(`[provider-trace] wrote Qoder empty stream trace: ${tracePath}`);

  return {
    ok: true,
    messages: body.messages,
    providerTracePath: tracePath,
    ...streamResult,
  };
}
