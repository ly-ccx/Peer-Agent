// User uploads share the classic composer's limits. Validate again at the durable
// boundary: renderer metadata cannot authorize filesystem reads or extra context.
export const INPUT_ATTACHMENT_LIMIT = 8;
const IMAGE_BYTES = 8 * 1024 * 1024;
const TEXT_BYTES = 512 * 1024;

export function normalizeUserUpload(item) {
  const token = (value, limit, fallback) => typeof value === 'string' && value.trim()
    ? value.trim().slice(0, limit) : fallback;
  const size = item?.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('attachment size is invalid');
  const base = { id: token(item.id, 80, 'attachment'), name: token(item.name, 240, 'file'),
    mimeType: token(item.mimeType, 100, 'application/octet-stream'), size, sourceKind: 'user_upload' };
  if (item.kind === 'image') {
    const url = item.dataUrl;
    const match = typeof url === 'string' && /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || match[1] !== base.mimeType || !match[2] || match[2].length % 4 !== 0) {
      throw new TypeError('attachment image data is invalid');
    }
    if (size > IMAGE_BYTES || match[2].length > Math.ceil(IMAGE_BYTES / 3) * 4
      || Buffer.from(match[2], 'base64').byteLength > IMAGE_BYTES) throw new TypeError('attachment image exceeds 8 MiB');
    return { ...base, kind: 'image', dataUrl: url };
  }
  if (item.kind === 'text') {
    if (typeof item.text !== 'string') throw new TypeError('attachment text is invalid');
    if (size > TEXT_BYTES || Buffer.byteLength(item.text, 'utf8') > TEXT_BYTES) throw new TypeError('attachment text exceeds 512 KiB');
    return { ...base, kind: 'text', text: item.text };
  }
  if (item.kind === 'unsupported') return { ...base, kind: 'unsupported' };
  throw new TypeError('attachment kind is invalid');
}
