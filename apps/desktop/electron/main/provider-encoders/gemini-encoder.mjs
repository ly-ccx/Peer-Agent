import { normalizeOpenAIContent, normalizeOpenAIMessages } from './message-normalizer.mjs';

function textPart(text) {
  const value = typeof text === 'string' ? text : '';
  return value ? { text: value } : null;
}

function imagePart(part) {
  const url = part?.image_url?.url;
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(url);
  if (!match) return null;
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

function openAIContentToGeminiParts(content) {
  const normalized = normalizeOpenAIContent(content);
  if (typeof normalized === 'string') return [textPart(normalized)].filter(Boolean);
  if (!Array.isArray(normalized)) return [];
  return normalized
    .map((part) => {
      if (part?.type === 'text') return textPart(part.text);
      if (part?.type === 'image_url') return imagePart(part);
      return null;
    })
    .filter(Boolean);
}

function positiveTokenLimit(value) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

function openAIToolsToGeminiTools(tools = []) {
  const declarations = (tools || [])
    .map((tool) => tool?.function || tool)
    .filter((fn) => fn?.name)
    .map((fn) => ({
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
    }));
  return declarations.length ? [{ functionDeclarations: declarations }] : undefined;
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function messageToGeminiContent(message) {
  if (message?.geminiContent) return message.geminiContent;
  if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const parts = openAIContentToGeminiParts(message.content);
    for (const toolCall of message.tool_calls) {
      const name = toolCall?.function?.name;
      if (!name) continue;
      parts.push({
        functionCall: {
          name,
          args: parseToolArguments(toolCall.function?.arguments),
        },
      });
    }
    if (!parts.length) return null;
    return { role: 'model', parts };
  }
  if (message?.role === 'tool' && message.name) {
    return {
      role: 'user',
      parts: [{
        functionResponse: {
          name: message.name,
          response: { result: message.content ?? '' },
        },
      }],
    };
  }
  const parts = openAIContentToGeminiParts(message?.content);
  if (!parts.length) return null;
  return {
    role: message?.role === 'assistant' ? 'model' : 'user',
    parts,
  };
}

export function encodeGeminiGenerateContentRequest({
  messages,
  tools,
  maxOutputTokens,
  model,
  projectId,
  authMethod,
  userPromptId,
  sessionId,
} = {}) {
  const normalized = normalizeOpenAIMessages(messages);
  const systemText = normalized
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .filter(Boolean)
    .join('\n\n');

  const contents = normalized
    .filter((message) => message.role !== 'system')
    .map(messageToGeminiContent)
    .filter(Boolean);

  const body = {
    contents,
    tools: openAIToolsToGeminiTools(tools),
  };
  const outputLimit = positiveTokenLimit(maxOutputTokens);
  if (outputLimit) body.generationConfig = { maxOutputTokens: outputLimit };
  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }

  // Gemini OAuth / Code Assist 请求体对齐 gemini-cli converter.toGenerateContentRequest：
  // { model, project, request: { contents, systemInstruction, tools, generationConfig, session_id } }
  if (authMethod === 'oauth_google') {
    const modelId = String(model || '').replace(/^models\//, '');
    const request = { ...body };
    if (sessionId) request.session_id = String(sessionId);
    const wrapped = {
      model: modelId,
      request,
    };
    if (projectId) wrapped.project = String(projectId);
    if (userPromptId) wrapped.user_prompt_id = String(userPromptId);
    return wrapped;
  }

  return body;
}
