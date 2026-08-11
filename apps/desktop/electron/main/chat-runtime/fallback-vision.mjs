/**
 * 兜底多模态：主模型不支持 vision 时，仅对本轮新图做剥离 / 识别注入。
 * 纯消息变换 + 一次性识别调用；不改会话落盘真值。
 */

import { encodeOpenAIResponsesRequest } from '../provider-encoders/responses-encoder.mjs';

const STRIP_PLACEHOLDER = '[image omitted: current model does not support vision]';
const RECOGNITION_SYSTEM_PROMPT =
  'You are a vision assistant. Describe each image clearly and factually so a text-only model can continue the task. Reply in the same language as any accompanying user text when possible. Be concise but complete.';

export function messageHasImageParts(message) {
  if (!message || typeof message !== 'object') return false;
  const content = message.content;
  if (!Array.isArray(content)) return false;
  return content.some((part) => part && typeof part === 'object' && part.type === 'image_url' && part.image_url?.url);
}

export function extractImageUrlsFromMessage(message) {
  if (!message || typeof message !== 'object') return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'image_url') {
      const url = part.image_url?.url;
      if (typeof url === 'string' && url.trim()) urls.push(url.trim());
    }
  }
  return urls;
}

export function stripImagePartsFromMessage(message, { placeholder = STRIP_PLACEHOLDER } = {}) {
  if (!messageHasImageParts(message)) {
    return { message, strippedCount: 0 };
  }
  const nextParts = [];
  let strippedCount = 0;
  for (const part of message.content) {
    if (part && typeof part === 'object' && part.type === 'image_url') {
      strippedCount += 1;
      continue;
    }
    nextParts.push(part);
  }
  if (strippedCount > 0) {
    const hasText = nextParts.some(
      (part) =>
        (typeof part === 'string' && part.trim()) ||
        (part && typeof part === 'object' && part.type === 'text' && String(part.text || part.content || '').trim()),
    );
    if (!hasText) {
      nextParts.unshift({ type: 'text', text: placeholder });
    }
  }
  const content =
    nextParts.length === 1 && typeof nextParts[0] === 'string'
      ? nextParts[0]
      : nextParts.length === 1 && nextParts[0]?.type === 'text' && typeof nextParts[0].text === 'string'
        ? nextParts[0].text
        : nextParts;
  return {
    message: { ...message, content },
    strippedCount,
  };
}

/**
 * 仅处理 messages 末尾连续 user 消息中的图片（本轮新图）。
 * 历史里的图不触发。
 */
export function processTrailingUserImages(messages, {
  supportsVision,
  imageDescriptions = null,
  stripPlaceholder = STRIP_PLACEHOLDER,
} = {}) {
  const source = Array.isArray(messages) ? messages : [];
  if (supportsVision || source.length === 0) {
    return {
      messages: source,
      changed: false,
      strippedImageCount: 0,
      recognizedImageCount: 0,
      trailingUserIndexes: [],
      imageUrls: [],
    };
  }

  const trailingUserIndexes = [];
  for (let i = source.length - 1; i >= 0; i -= 1) {
    if (source[i]?.role === 'user') trailingUserIndexes.unshift(i);
    else break;
  }
  if (trailingUserIndexes.length === 0) {
    return {
      messages: source,
      changed: false,
      strippedImageCount: 0,
      recognizedImageCount: 0,
      trailingUserIndexes: [],
      imageUrls: [],
    };
  }

  const imageUrls = [];
  for (const index of trailingUserIndexes) {
    imageUrls.push(...extractImageUrlsFromMessage(source[index]));
  }
  if (imageUrls.length === 0) {
    return {
      messages: source,
      changed: false,
      strippedImageCount: 0,
      recognizedImageCount: 0,
      trailingUserIndexes,
      imageUrls: [],
    };
  }

  const next = source.slice();
  let strippedImageCount = 0;
  let recognizedImageCount = 0;
  let descriptionCursor = 0;
  const descriptions = Array.isArray(imageDescriptions) ? imageDescriptions : null;

  for (const index of trailingUserIndexes) {
    const original = next[index];
    const urls = extractImageUrlsFromMessage(original);
    if (urls.length === 0) continue;

    if (descriptions) {
      const chunks = [];
      for (let i = 0; i < urls.length; i += 1) {
        const text = String(descriptions[descriptionCursor + i] || '').trim();
        if (text) chunks.push(text);
      }
      descriptionCursor += urls.length;
      const { message: stripped, strippedCount } = stripImagePartsFromMessage(original, {
        placeholder: '',
      });
      strippedImageCount += strippedCount;
      recognizedImageCount += chunks.length;
      const injection = chunks.length
        ? `[Image recognition]\n${chunks.map((chunk, i) => (chunks.length > 1 ? `${i + 1}. ${chunk}` : chunk)).join('\n')}`
        : stripPlaceholder;
      next[index] = injectTextIntoUserMessage(stripped, injection);
    } else {
      const { message: stripped, strippedCount } = stripImagePartsFromMessage(original, {
        placeholder: stripPlaceholder,
      });
      strippedImageCount += strippedCount;
      next[index] = stripped;
    }
  }

  return {
    messages: next,
    changed: strippedImageCount > 0,
    strippedImageCount,
    recognizedImageCount,
    trailingUserIndexes,
    imageUrls,
  };
}

function injectTextIntoUserMessage(message, text) {
  const injection = String(text || '').trim();
  if (!injection) return message;
  const content = message?.content;
  if (typeof content === 'string') {
    const base = content.trim();
    return { ...message, content: base ? `${base}\n\n${injection}` : injection };
  }
  if (Array.isArray(content)) {
    const nextParts = content.slice();
    const textIndexes = nextParts
      .map((part, index) => (
        part && typeof part === 'object' && part.type === 'text' ? index : -1
      ))
      .filter((index) => index >= 0);
    if (textIndexes.length > 0) {
      const last = textIndexes[textIndexes.length - 1];
      const part = nextParts[last];
      const prev = String(part.text || part.content || '').trim();
      nextParts[last] = {
        ...part,
        type: 'text',
        text: prev ? `${prev}\n\n${injection}` : injection,
      };
      return { ...message, content: nextParts };
    }
    return {
      ...message,
      content: [{ type: 'text', text: injection }, ...nextParts],
    };
  }
  return { ...message, content: injection };
}

export function buildFallbackVisionUserContent(imageUrls, userText = '') {
  const parts = [];
  const text = String(userText || '').trim();
  parts.push({
    type: 'text',
    text: text
      ? `Describe the following image(s) for a text-only model. User context:\n${text}`
      : 'Describe the following image(s) for a text-only model. Focus on UI layout, text, code, errors, and task-relevant details.',
  });
  for (const url of imageUrls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

/**
 * 用兜底 vision provider 做一次性非流式识别。
 * deps: { getCredential, resolveChannel, fetchImpl }
 */
export async function recognizeImagesWithFallbackProvider({
  provider,
  imageUrls,
  userText = '',
  getCredential,
  resolveChannel,
  fetchImpl = null,
  timeoutMs = 45000,
}) {
  if (!provider || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { ok: false, error: 'missing_provider_or_images', descriptions: [] };
  }
  if (typeof getCredential !== 'function' || typeof resolveChannel !== 'function') {
    return { ok: false, error: 'missing_deps', descriptions: [] };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch_unavailable', descriptions: [] };
  }

  let credential;
  try {
    credential = await getCredential(provider.id);
  } catch {
    return { ok: false, error: 'credential_resolution_failed', descriptions: [] };
  }

  let resolved;
  try {
    resolved = resolveChannel({
      ...provider,
      apiKey: credential?.apiKey,
      accessToken: credential?.accessToken || credential?.oauthTokens?.accessToken,
      oauthTokens: credential?.oauthTokens,
    });
  } catch {
    return { ok: false, error: 'resolve_channel_failed', descriptions: [] };
  }

  const wire = resolved.wire || 'openai-chat';
  const content = buildFallbackVisionUserContent(imageUrls, userText);
  const endpoint = resolved.endpoint || resolved.baseUrl;
  if (!endpoint) {
    return { ok: false, error: 'missing_endpoint', descriptions: [] };
  }

  try {
    if (wire === 'anthropic-messages') {
      const url = String(endpoint).replace(/\/$/, '') + (String(endpoint).includes('/v1/messages') ? '' : '/v1/messages');
      const anthropicContent = content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text };
        const urlValue = part.image_url?.url || '';
        const match = String(urlValue).match(/^data:(image\/[^;,]+);base64,(.+)$/s);
        if (match) {
          return {
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2].replace(/\s+/g, '') },
          };
        }
        return {
          type: 'image',
          source: { type: 'url', url: urlValue },
        };
      });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(resolved.headers || {}),
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 1024,
          system: RECOGNITION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: anthropicContent }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, error: `anthropic_${res.status}:${text.slice(0, 200)}`, descriptions: [] };
      }
      const data = await res.json();
      const text = Array.isArray(data?.content)
        ? data.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim()
        : '';
      return text
        ? { ok: true, descriptions: [text], providerId: provider.id }
        : { ok: false, error: 'empty_recognition', descriptions: [] };
    }

    if (wire === 'openai-responses') {
      const url = /\/responses$/.test(String(endpoint).replace(/\/$/, ''))
        ? String(endpoint).replace(/\/$/, '')
        : `${String(endpoint).replace(/\/$/, '')}/responses`;
      const body = encodeOpenAIResponsesRequest({
        model: provider.model,
        messages: [
          { role: 'system', content: RECOGNITION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        maxOutputTokens: 1024,
      });
      body.stream = false;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(resolved.headers || {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        await res.text().catch(() => '');
        return { ok: false, error: `openai_responses_http_${res.status}`, descriptions: [] };
      }
      const data = await res.json();
      const text = String(data?.output_text || '') || (Array.isArray(data?.output)
        ? data.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
          .filter((part) => part?.type === 'output_text')
          .map((part) => part.text || '')
          .join('\n')
        : '');
      const normalized = text.trim();
      return normalized
        ? { ok: true, descriptions: [normalized], providerId: provider.id, wire }
        : { ok: false, error: 'empty_recognition', descriptions: [] };
    }

    // openai-chat / compatible: OpenAI chat completions shape.
    const base = String(endpoint).replace(/\/$/, '');
    const url = /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(resolved.headers || {}),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: RECOGNITION_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.text().catch(() => '');
      return { ok: false, error: `openai_chat_http_${res.status}`, descriptions: [] };
    }
    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    return text
      ? { ok: true, descriptions: [text], providerId: provider.id, wire }
      : { ok: false, error: 'empty_recognition', descriptions: [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'recognition_failed', descriptions: [] };
  }
}

export function readFallbackVisionProviderId(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const raw = settings.fallbackVision;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object' && typeof raw.providerId === 'string' && raw.providerId.trim()) {
    return raw.providerId.trim();
  }
  return null;
}

export { STRIP_PLACEHOLDER, RECOGNITION_SYSTEM_PROMPT };
