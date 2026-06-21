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

function messageToGeminiContent(message) {
  if (message?.geminiContent) return message.geminiContent;
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
}) {
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
  return body;
}
