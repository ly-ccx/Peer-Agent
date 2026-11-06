// Frozen public layout normalizer body from 518420a4; TypeScript annotations removed.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
export function normalizeResourceLayout(raw) {
  if (!object(raw) || !keys(raw, ['order', 'recent'])) return;
  const list = (value, limit) => Array.isArray(value) && value.length <= limit
    && value.every(key => typeof key === 'string' && key.length <= 8192 && !/[\u0000-\u001f]/.test(key)
      && (key === 'launcher' || /^(?:document|browser|conversation|interactive):.+$/.test(key))) && new Set(value).size === value.length;
  if (!list(raw.order, 200) || !list(raw.recent, 16) || new TextEncoder().encode(JSON.stringify(raw)).byteLength > 256 * 1024) return;
  return { order: [...raw.order], recent: [...raw.recent] };
}
