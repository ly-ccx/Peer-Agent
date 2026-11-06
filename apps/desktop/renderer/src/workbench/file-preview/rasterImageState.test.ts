import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRasterDataUrl, rasterZoom, RASTER_MAX_BYTES } from './rasterImageState.ts';

// Synthetic headers verify admission only; they do not claim native codec decoding success.
export function pngHeader(width = 2, height = 3) {
  const b = Buffer.alloc(33); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
}
test('accepts bounded raster headers and rejects MIME spoofing, remote URLs and SVG', () => {
  assert.deepEqual(inspectRasterDataUrl(pngHeader()), { ok: true, mime: 'image/png', width: 2, height: 3 });
  for (const value of ['https://example.invalid/a.png', 'data:image/svg+xml;base64,PHN2Zz4=', pngHeader().replace('image/png', 'image/jpeg'),
    'data:image/png;base64,!!!!', 'data:image/png;base64,AA==']) assert.deepEqual(inspectRasterDataUrl(value), { ok: false, reason: 'format' });
});
test('rejects byte, pixel and axis limits before native decoding and keeps zoom bounded', () => {
  assert.deepEqual(inspectRasterDataUrl(pngHeader(16385, 1)), { ok: false, reason: 'dimensions' });
  assert.deepEqual(inspectRasterDataUrl(pngHeader(8000, 8000)), { ok: false, reason: 'dimensions' });
  assert.deepEqual(inspectRasterDataUrl(pngHeader(0, 1)), { ok: false, reason: 'dimensions' });
  assert.deepEqual(inspectRasterDataUrl('data:image/png;base64,' + 'A'.repeat(Math.ceil(RASTER_MAX_BYTES / 3) * 4 + 4)), { ok: false, reason: 'size' });
  assert.equal(rasterZoom(4, 1), 4); assert.equal(rasterZoom(0.25, -1), 0.25); assert.equal(rasterZoom(1, -1), 0.75);
});
test('recognizes GIF, BMP, JPEG and WebP dimensions using their own byte order', () => {
  const gif = Buffer.alloc(13); gif.write('GIF89a'); gif.writeUInt16LE(7, 6); gif.writeUInt16LE(8, 8);
  const bmp = Buffer.alloc(54); bmp.write('BM'); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(9, 18); bmp.writeInt32LE(-10, 22);
  const jpeg = Buffer.from([255,216,255,192,0,8,8,0,11,0,12,1]);
  const webp = Buffer.alloc(30); webp.write('RIFF'); webp.write('WEBP',8); webp.write('VP8X',12); webp[24] = 12; webp[27] = 13;
  for (const [mime, bytes, width, height] of [['gif',gif,7,8], ['bmp',bmp,9,10], ['jpeg',jpeg,12,11], ['webp',webp,13,14]] as const) {
    assert.deepEqual(inspectRasterDataUrl(`data:image/${mime};base64,${bytes.toString('base64')}`), { ok: true, mime: `image/${mime}`, width, height });
  }
});
