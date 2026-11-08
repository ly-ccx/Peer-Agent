// Regenerate build/icon.ico from the accepted brand artwork.
// Windows renders .ico pixels as-is — there is no system squircle like macOS,
// so the ico must carry the rounded mask itself or the exe/taskbar icon shows
// straight corners. Reuse the Dock PNG alpha (the accepted rounded mask) scaled
// to fill the canvas, applied to the full-bleed icon.png artwork, then emit the
// same 16–256 size ladder as the previous ico (PNG-compressed entries).
// Pure Node (no dependencies): hand-rolled PNG codec + premultiplied Lanczos3
// resampling, same decode approach as electron/main/app-icon-fullbleed.test.mjs.
// Run from apps/desktop: node scripts/build-windows-icon.mjs
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const MASTER = 1024;

// ── PNG decode (8-bit RGBA, non-interlaced) ──
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function readPngRgba(filePath) {
  const data = readFileSync(filePath);
  if (data.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`${filePath} is not a PNG`);
  }
  const idat = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      if (chunk[8] !== 8 || chunk[9] !== 6 || chunk[12] !== 0) {
        throw new Error(`${filePath} must be 8-bit RGBA non-interlaced`);
      }
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const pixels = new Uint8Array(width * height * bpp);
  let i = 0;
  const row = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[i];
    i += 1;
    row.set(raw.subarray(i, i + stride));
    i += stride;
    if (filter === 1) {
      for (let x = bpp; x < stride; x += 1) row[x] = (row[x] + row[x - bpp]) & 255;
    } else if (filter === 2) {
      for (let x = 0; x < stride; x += 1) row[x] = (row[x] + prev[x]) & 255;
    } else if (filter === 3) {
      for (let x = 0; x < stride; x += 1) {
        const left = x >= bpp ? row[x - bpp] : 0;
        row[x] = (row[x] + Math.floor((left + prev[x]) / 2)) & 255;
      }
    } else if (filter === 4) {
      for (let x = 0; x < stride; x += 1) {
        const left = x >= bpp ? row[x - bpp] : 0;
        const up = prev[x];
        const upLeft = x >= bpp ? prev[x - bpp] : 0;
        row[x] = (row[x] + paeth(left, up, upLeft)) & 255;
      }
    } else if (filter !== 0) {
      throw new Error(`${filePath} has unsupported PNG filter ${filter}`);
    }
    pixels.set(row, y * stride);
    prev.set(row);
  }
  return { width, height, pixels };
}

// ── PNG encode (8-bit RGBA, filter 0 rows) ──
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encodePngRgba(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Premultiplied Lanczos3 resampling ──
function lanczos3(x) {
  const ax = Math.abs(x);
  if (ax >= 3) return 0;
  if (ax === 0) return 1;
  const sinc = (t) => (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t));
  return sinc(ax) * sinc(ax / 3);
}

function buildWeights(inLen, outLen) {
  const step = inLen / outLen;
  const scale = Math.max(1, step);
  const support = 3 * scale;
  const plan = [];
  for (let o = 0; o < outLen; o += 1) {
    const center = (o + 0.5) * step - 0.5;
    const start = Math.max(0, Math.ceil(center - support));
    const end = Math.min(inLen - 1, Math.floor(center + support));
    const weights = [];
    let sum = 0;
    for (let i = start; i <= end; i += 1) {
      const w = lanczos3((i - center) / scale);
      weights.push(w);
      sum += w;
    }
    for (let k = 0; k < weights.length; k += 1) weights[k] /= sum;
    plan.push({ start, weights });
  }
  return plan;
}

function premultiply(pixels) {
  const out = new Float64Array(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3] / 255;
    out[i] = pixels[i] * a;
    out[i + 1] = pixels[i + 1] * a;
    out[i + 2] = pixels[i + 2] * a;
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

function unpremultiply(pixels) {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const a = pixels[i + 3];
    const factor = a > 0 ? 255 / a : 0;
    out[i] = Math.min(255, pixels[i] * factor);
    out[i + 1] = Math.min(255, pixels[i + 1] * factor);
    out[i + 2] = Math.min(255, pixels[i + 2] * factor);
    out[i + 3] = a;
  }
  return out;
}

function resizeLanczos3(srcPixels, sw, sh, dw, dh) {
  const pre = premultiply(srcPixels);
  // Horizontal pass: (sw, sh) -> (dw, sh)
  const hPlan = buildWeights(sw, dw);
  const mid = new Float64Array(dw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const rowBase = y * sw * 4;
    for (let x = 0; x < dw; x += 1) {
      const { start, weights } = hPlan[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const idx = rowBase + (start + k) * 4;
        const w = weights[k];
        r += pre[idx] * w;
        g += pre[idx + 1] * w;
        b += pre[idx + 2] * w;
        a += pre[idx + 3] * w;
      }
      const midBase = (y * dw + x) * 4;
      mid[midBase] = r;
      mid[midBase + 1] = g;
      mid[midBase + 2] = b;
      mid[midBase + 3] = a;
    }
  }
  // Vertical pass: (dw, sh) -> (dw, dh)
  const vPlan = buildWeights(sh, dh);
  const out = new Float64Array(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const { start, weights } = vPlan[y];
    for (let x = 0; x < dw; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < weights.length; k += 1) {
        const idx = ((start + k) * dw + x) * 4;
        const w = weights[k];
        r += mid[idx] * w;
        g += mid[idx + 1] * w;
        b += mid[idx + 2] * w;
        a += mid[idx + 3] * w;
      }
      const outBase = (y * dw + x) * 4;
      out[outBase] = r;
      out[outBase + 1] = g;
      out[outBase + 2] = b;
      out[outBase + 3] = a;
    }
  }
  return unpremultiply(out);
}

// ── Assembly ──
const buildDir = fileURLToPath(new URL('../build/', import.meta.url));
const artwork = readPngRgba(`${buildDir}icon.png`);
const dock = readPngRgba(`${buildDir}icon-macos-dock.png`);
if (artwork.width !== MASTER || artwork.height !== MASTER) throw new Error('icon.png must be 1024×1024');
if (dock.width !== MASTER || dock.height !== MASTER) throw new Error('icon-macos-dock.png must be 1024×1024');

// 1. Locate the crisp mask bounds (alpha >= 128) on the Dock canvas.
let x0 = MASTER, y0 = MASTER, x1 = -1, y1 = -1;
for (let y = 0; y < MASTER; y += 1) {
  for (let x = 0; x < MASTER; x += 1) {
    if (dock.pixels[(y * MASTER + x) * 4 + 3] >= 128) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
}
if (x1 < 0) throw new Error('dock icon has no opaque mask');
const shapeWidth = x1 - x0 + 1;
const shapeHeight = y1 - y0 + 1;
console.log(`dock mask shape: (${x0},${y0})–(${x1},${y1}) ${shapeWidth}×${shapeHeight}`);

// 2. Extract the mask alpha (RGB dummy 255), scaled to fill the full canvas.
const maskCrop = new Uint8ClampedArray(shapeWidth * shapeHeight * 4);
for (let y = 0; y < shapeHeight; y += 1) {
  for (let x = 0; x < shapeWidth; x += 1) {
    const src = ((y + y0) * MASTER + (x + x0)) * 4;
    const dst = (y * shapeWidth + x) * 4;
    maskCrop[dst] = 255;
    maskCrop[dst + 1] = 255;
    maskCrop[dst + 2] = 255;
    maskCrop[dst + 3] = dock.pixels[src + 3];
  }
}
const maskFull = resizeLanczos3(maskCrop, shapeWidth, shapeHeight, MASTER, MASTER);

// 3. Punch the mask out of the full-resolution artwork (artwork is fully opaque,
//    so the composite alpha is exactly the mask alpha).
const masked = new Uint8ClampedArray(artwork.pixels);
for (let i = 3; i < masked.length; i += 4) masked[i] = maskFull[i];

// 4. Render each ico size from the masked master and assemble the ICO
//    (ICONDIR + ICONDIRENTRY per size + PNG blobs; 256 encodes as byte 0).
const entries = ICO_SIZES.map((size) => ({
  size,
  data: encodePngRgba(size, size, resizeLanczos3(masked, MASTER, MASTER, size, size)),
}));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const directory = [];
const blobs = [];
let offset = 6 + 16 * entries.length;
for (const entry of entries) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt8(entry.size === 256 ? 0 : entry.size, 0);
  descriptor.writeUInt8(entry.size === 256 ? 0 : entry.size, 1);
  descriptor.writeUInt16LE(1, 4);
  descriptor.writeUInt16LE(32, 6);
  descriptor.writeUInt32LE(entry.data.length, 8);
  descriptor.writeUInt32LE(offset, 12);
  offset += entry.data.length;
  directory.push(descriptor);
  blobs.push(entry.data);
}
const icoPath = `${buildDir}icon.ico`;
writeFileSync(icoPath, Buffer.concat([header, ...directory, ...blobs]));
console.log(`wrote ${icoPath} (${entries.length} sizes: ${ICO_SIZES.join(', ')})`);
