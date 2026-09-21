import { createHash } from 'node:crypto';

export const hashVisualBytes = bytes => createHash('sha256').update(bytes).digest('hex');
function pngHash(base64) {
  if (typeof base64 !== 'string' || base64.length > 12 * 1024 * 1024
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return hashVisualBytes(bytes);
}
export function visualDataUrlHash(url) {
  return typeof url === 'string' && url.startsWith('data:image/png;base64,')
    ? pngHash(url.slice('data:image/png;base64,'.length)) : null;
}
/** Inspect only native image positions, never tool text, prompts or arbitrary JSON. */
export function encodedVisualImageHashes(bodyText, wire) {
  const hashes = new Set();
  if (typeof bodyText !== 'string') return hashes;
  let body;
  try { body = JSON.parse(bodyText); } catch { return hashes; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return hashes;
  const array = value => Array.isArray(value) ? value : [];
  const add = hash => { if (hash) hashes.add(hash); };
  if (wire === 'openai') {
    for (const message of array(body.messages)) {
      if (message?.role !== 'user') continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'image_url') add(visualDataUrlHash(block.image_url?.url));
      }
    }
  } else if (wire === 'openai-responses') {
    for (const message of Array.isArray(body.input) ? body.input : []) {
      if (message?.role !== 'user') continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'input_image') add(visualDataUrlHash(block.image_url));
      }
    }
  } else if (wire === 'anthropic') {
    for (const message of array(body.messages)) {
      if (message?.role !== 'user') continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const blocks = block?.type === 'tool_result' && Array.isArray(block.content) ? block.content : [block];
        for (const image of blocks) {
          if (image?.type === 'image' && image.source?.type === 'base64' && image.source.media_type === 'image/png') add(pngHash(image.source.data));
        }
      }
    }
  } else if (wire === 'gemini') {
    const request = body.request && typeof body.request === 'object' ? body.request : body;
    for (const message of array(request.contents)) {
      if (message?.role !== 'user') continue;
      for (const part of array(message.parts)) {
        if (part?.inlineData?.mimeType === 'image/png') add(pngHash(part.inlineData.data));
      }
    }
  }
  return hashes;
}
