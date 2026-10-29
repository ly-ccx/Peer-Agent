export const RASTER_MAX_BYTES = 8 * 1024 * 1024;
export const RASTER_MAX_DIMENSION = 16_384;
export const RASTER_MAX_PIXELS = 32_000_000;
export type RasterInspection = { readonly ok: true; readonly mime: string; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly reason: 'format' | 'size' | 'dimensions' };
function ascii(bytes: Uint8Array, start: number, length: number) { return String.fromCharCode(...bytes.subarray(start, start + length)); }
function dimensions(b: Uint8Array, mime: string): readonly [number, number] | null {
  const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (mime === 'image/png' && b.length >= 33 && ascii(b, 1, 3) === 'PNG' && b[0] === 137
    && b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10 && ascii(b, 12, 4) === 'IHDR' && d.getUint32(8) === 13)
    return [d.getUint32(16), d.getUint32(20)];
  if (mime === 'image/gif' && b.length >= 13 && ['GIF87a', 'GIF89a'].includes(ascii(b, 0, 6))) return [d.getUint16(6, true), d.getUint16(8, true)];
  if (mime === 'image/bmp' && b.length >= 54 && ascii(b, 0, 2) === 'BM' && d.getUint32(14, true) >= 40)
    return [d.getInt32(18, true), Math.abs(d.getInt32(22, true))];
  if (mime === 'image/jpeg' && b.length >= 4 && b[0] === 255 && b[1] === 216) {
    for (let offset = 2; offset + 4 <= b.length;) {
      if (b[offset++] !== 255) return null;
      while (offset < b.length && b[offset] === 255) offset++;
      const marker = b[offset++];
      if (marker === undefined || marker === 217 || marker === 218) return null;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > b.length) return null;
      const length = d.getUint16(offset);
      if (length < 2 || offset + length > b.length) return null;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 8)
        return [d.getUint16(offset + 5), d.getUint16(offset + 3)];
      offset += length;
    }
  }
  if (mime === 'image/webp' && b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const kind = ascii(b, 12, 4);
    const u24 = (offset: number) => b[offset]! + (b[offset + 1]! << 8) + (b[offset + 2]! << 16);
    if (kind === 'VP8X') return [1 + u24(24), 1 + u24(27)];
    if (kind === 'VP8 ' && b[23] === 157 && b[24] === 1 && b[25] === 42) return [d.getUint16(26, true) & 16383, d.getUint16(28, true) & 16383];
    if (kind === 'VP8L' && b[20] === 47) return [1 + (b[21]! | (b[22]! & 63) << 8), 1 + ((b[22]! >> 6) | b[23]! << 2 | (b[24]! & 15) << 10)];
  }
  return null;
}
/** No DOM, filesystem or network. Header inspection is bounded before the browser decodes. */
export function inspectRasterDataUrl(value: string): RasterInspection {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,/i.exec(value);
  if (!match) return { ok: false, reason: 'format' };
  const payload = value.slice(match[0].length);
  if (payload.length > Math.ceil(RASTER_MAX_BYTES / 3) * 4) return { ok: false, reason: 'size' };
  if (!payload || payload.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return { ok: false, reason: 'format' };
  const bytes = payload.length / 4 * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0);
  if (bytes > RASTER_MAX_BYTES) return { ok: false, reason: 'size' };
  try {
    const header = atob(payload.slice(0, 87_380)); // <= 64 KiB, even with unusually long JPEG metadata.
    const mime = match[1]!.toLowerCase();
    const size = dimensions(Uint8Array.from(header, char => char.charCodeAt(0)), mime);
    if (!size) return { ok: false, reason: 'format' };
    const [width, height] = size;
    if (!width || !height || width < 0 || height < 0 || width > RASTER_MAX_DIMENSION || height > RASTER_MAX_DIMENSION || width * height > RASTER_MAX_PIXELS)
      return { ok: false, reason: 'dimensions' };
    return { ok: true, mime, width, height };
  } catch { return { ok: false, reason: 'format' }; }
}
export function rasterZoom(current: number, direction: -1 | 1): number { return Math.max(0.25, Math.min(4, current + direction * 0.25)); }
