import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const BUILD_DIR = path.resolve(fileURLToPath(new URL('../../build/', import.meta.url)));

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
  assert.equal(data.subarray(0, 8).toString('binary'), '\x89PNG\r\n\x1a\n', `${filePath} is not a PNG`);

  const idat = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString('ascii');
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8];
      colorType = chunk[9];
    } else if (type === 'IDAT') {
      idat.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  assert.equal(bitDepth, 8, `${filePath} must be 8-bit`);
  assert.equal(colorType, 6, `${filePath} must be RGBA`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const rows = [];
  let i = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[i];
    i += 1;
    const row = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    if (filter === 1) {
      for (let x = 0; x < stride; x += 1) {
        const left = x >= bpp ? row[x - bpp] : 0;
        row[x] = (row[x] + left) & 255;
      }
    } else if (filter === 2) {
      for (let x = 0; x < stride; x += 1) {
        row[x] = (row[x] + prev[x]) & 255;
      }
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
    } else {
      assert.equal(filter, 0, `${filePath} has unsupported PNG filter ${filter}`);
    }
    rows.push(row);
    prev = row;
  }

  return { width, height, rows };
}

function pixel(rows, x, y) {
  const i = x * 4;
  const row = rows[y];
  return [row[i], row[i + 1], row[i + 2], row[i + 3]];
}

function assertFullBleedPng(filePath) {
  const { width, height, rows } = readPngRgba(filePath);
  assert.equal(width, 1024, `${filePath} width`);
  assert.equal(height, 1024, `${filePath} height`);

  const corners = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ];
  for (const [x, y] of corners) {
    const [, , , a] = pixel(rows, x, y);
    assert.equal(a, 255, `${filePath} corner (${x},${y}) must be opaque`);
  }

  let minAlpha = 255;
  let transparent = 0;
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    for (let x = 0; x < width; x += 1) {
      const a = row[x * 4 + 3];
      if (a < minAlpha) minAlpha = a;
      if (a < 255) transparent += 1;
    }
  }
  assert.equal(minAlpha, 255, `${filePath} must have no transparent edge`);
  assert.equal(transparent, 0, `${filePath} must be fully opaque`);
}

describe('macOS app icon full-bleed canvas', () => {
  it('keeps icon.png 1024×1024 with opaque corners and no transparent border', () => {
    assertFullBleedPng(path.join(BUILD_DIR, 'icon.png'));
  });

  it('keeps Dock light and dark icons on the same full-bleed canvas', () => {
    assertFullBleedPng(path.join(BUILD_DIR, 'icon-macos-dock.png'));
    assertFullBleedPng(path.join(BUILD_DIR, 'icon-macos-dock-dark.png'));
  });
});
