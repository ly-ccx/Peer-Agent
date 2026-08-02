function parseDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  const mediaType = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), 'utf8').toString('base64');
  return { mediaType, data };
}

export function normalizeOpenAIContent(content) {
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      parts.push({ type: 'image_url', image_url: { url: String(part.image_url.url) } });
    } else {
      parts.push(part);
    }
  }
  return parts.length ? parts : '';
}

export function normalizeAnthropicContent(content) {
  if (!Array.isArray(content)) return content;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed?.mediaType.startsWith('image/')) {
        parts.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        });
      }
    } else if (part.type === 'image' || part.type === 'tool_use' || part.type === 'tool_result') {
      parts.push(part);
    }
  }
  return parts.length ? parts : '';
}

export function normalizeOpenAIMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: normalizeOpenAIContent(message.content),
  }));
}

export function normalizeAnthropicMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: normalizeAnthropicContent(message.content),
  }));
}
