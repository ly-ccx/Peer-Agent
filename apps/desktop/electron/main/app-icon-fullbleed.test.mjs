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
  return readPngRgbaBuffer(data, filePath);
}

function readPngRgbaBuffer(data, filePath) {
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
    assert.ok(pads[name] >= 80, `${filePath} ${name} padding ${pads[name]}px is too tight; dock.setIcon would still look a size larger than neighboring apps`);
    assert.ok(pads[name] <= 140, `${filePath} ${name} padding ${pads[name]}px is a thick frame, expected a slightly inset optical size`);
  }
  assert.ok(pads.diag >= 145, `${filePath} diagonal becomes opaque at ${pads.diag}px; a full-bleed dock icon would be ~0–85`);
  assert.ok(pads.diag <= 200, `${filePath} diagonal padding ${pads.diag}px is too large; expected a slightly inset rounded-rect`);
}

describe('macOS app icon canvases', () => {
  it('keeps icon.png 1024×1024 fully opaque so icns/Notification use the system squircle', () => {
    assertOpaqueFullBleedPng(path.join(BUILD_DIR, 'icon.png'));
  });

  it('keeps Dock light and dark icons slightly inset with rounded corners', () => {
    assertDockOpticalSizePng(path.join(BUILD_DIR, 'icon-macos-dock.png'));
    assertDockOpticalSizePng(path.join(BUILD_DIR, 'icon-macos-dock-dark.png'));
  });
});

describe('Windows app icon (icon.ico)', () => {
  const ICO_PATH = path.join(BUILD_DIR, 'icon.ico');
  const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

  function readIcoEntries(filePath) {
    const data = readFileSync(filePath);
    assert.equal(data.readUInt16LE(0), 0, `${filePath} reserved word`);
    assert.equal(data.readUInt16LE(2), 1, `${filePath} must be an icon resource`);
    const count = data.readUInt16LE(4);
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const at = 6 + i * 16;
      const width = data[at] === 0 ? 256 : data[at];
      const height = data[at + 1] === 0 ? 256 : data[at + 1];
      const size = data.readUInt32LE(at + 8);
      const offset = data.readUInt32LE(at + 12);
      entries.push({ width, height, size, offset, data: data.subarray(offset, offset + size) });
    }
    return entries;
  }

  it('ships the same size ladder as the release ico, each entry PNG-encoded', () => {
    const entries = readIcoEntries(ICO_PATH);
    assert.deepEqual(
      entries.map((entry) => entry.width),
      ICO_SIZES,
      'ico size ladder must stay 16–256; Windows taskbar and Explorer pick from these',
    );
    for (const entry of entries) {
      assert.equal(entry.height, entry.width, 'ico entries must be square');
      assert.equal(
        entry.data.subarray(0, 8).toString('binary'),
        '\x89PNG\r\n\x1a\n',
        `ico ${entry.width}px entry must be PNG-compressed`,
      );
    }
  });

  it('carries the rounded mask itself so taskbar icons match the macOS look', () => {
    const entries = readIcoEntries(ICO_PATH);
    const largest = entries[entries.length - 1];
    assert.equal(largest.width, 256, 'largest ico entry must be 256px');
    const { width, height, rows } = readPngRgbaBuffer(largest.data, `${ICO_PATH} 256px entry`);
    assert.equal(width, 256);
    assert.equal(height, 256);

    const corners = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of corners) {
      assert.equal(alpha(rows, x, y), 0, `${ICO_PATH} corner (${x},${y}) must be transparent — Windows renders the ico as-is with no system squircle`);
    }
    assert.ok(alpha(rows, width / 2, height / 2) >= 200, `${ICO_PATH} center must stay opaque`);

    const pads = edgePads(rows, width, height);
    for (const name of ['left', 'right', 'top', 'bottom']) {
      assert.equal(pads[name], 0, `${ICO_PATH} ${name} pad must be 0 — the rounded shape fills the canvas like other Windows taskbar icons`);
    }
    assert.ok(pads.diag >= 12, `${ICO_PATH} diagonal becomes opaque at ${pads.diag}px — corners are not rounded (square corners reach it at 0)`);
    assert.ok(pads.diag <= 60, `${ICO_PATH} diagonal padding ${pads.diag}px is over-rounded for the brand mask`);
  });
});
