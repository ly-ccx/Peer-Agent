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

function alpha(rows, x, y) {
  return pixel(rows, x, y)[3];
}

function firstOpaqueAlong(getter, n, threshold = 16) {
  for (let t = 0; t < n; t += 1) {
    if (getter(t) > threshold) return t;
  }
  return n;
}

function edgePads(rows, width, height) {
  const midY = Math.floor(height / 2);
  const midX = Math.floor(width / 2);
  return {
    left: firstOpaqueAlong((t) => alpha(rows, t, midY), width),
    right: firstOpaqueAlong((t) => alpha(rows, width - 1 - t, midY), width),
    top: firstOpaqueAlong((t) => alpha(rows, midX, t), height),
    bottom: firstOpaqueAlong((t) => alpha(rows, midX, height - 1 - t), height),
    diag: firstOpaqueAlong((t) => alpha(rows, t, t), Math.min(width, height)),
  };
}

function assertOpaqueFullBleedPng(filePath) {
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
    assert.equal(alpha(rows, x, y), 255, `${filePath} corner (${x},${y}) must be opaque so Notification/Finder can apply the system squircle`);
  }

  const pads = edgePads(rows, width, height);
  for (const [name, pad] of Object.entries(pads)) {
    assert.equal(pad, 0, `${filePath} ${name} padding ${pad}px must be 0 — icns source must fill the canvas`);
  }

  let transparent = 0;
  for (let y = 0; y < height; y += 1) {
    const row = rows[y];
    for (let x = 0; x < width; x += 1) {
      if (row[x * 4 + 3] < 255) transparent += 1;
    }
  }
  assert.equal(transparent, 0, `${filePath} must have no pre-cut rounded transparent corners`);
}

function assertDockOpticalSizePng(filePath) {
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
    assert.equal(alpha(rows, x, y), 0, `${filePath} corner (${x},${y}) must stay transparent so dock.setIcon keeps the original rounded mask`);
  }

  const pads = edgePads(rows, width, height);
  for (const name of ['left', 'right', 'top', 'bottom']) {
    assert.ok(pads[name] >= 48, `${filePath} ${name} padding ${pads[name]}px is too tight; dock.setIcon would look a size larger than the original icon`);
    assert.ok(pads[name] <= 120, `${filePath} ${name} padding ${pads[name]}px is a thick frame, expected the original optical size`);
  }
  assert.ok(pads.diag >= 110, `${filePath} diagonal becomes opaque at ${pads.diag}px; a full-bleed dock icon would be ~0–85`);
  assert.ok(pads.diag <= 180, `${filePath} diagonal padding ${pads.diag}px is too large; expected the original rounded-rect radius`);
}

describe('macOS app icon canvases', () => {
  it('keeps icon.png 1024×1024 fully opaque so icns/Notification use the system squircle', () => {
    assertOpaqueFullBleedPng(path.join(BUILD_DIR, 'icon.png'));
  });

  it('keeps Dock light and dark icons on the original rounded optical size', () => {
    assertDockOpticalSizePng(path.join(BUILD_DIR, 'icon-macos-dock.png'));
    assertDockOpticalSizePng(path.join(BUILD_DIR, 'icon-macos-dock-dark.png'));
  });
});
