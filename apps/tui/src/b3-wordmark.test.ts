import { describe, expect, test } from 'bun:test';

import {
  B3_MATRIX_HEIGHT,
  B3_MATRIX_WIDTH,
  B3_PIXEL_MATRIX,
  B3_SIGNAL_COLUMNS,
  B3_SIGNAL_ROW,
  createB3PreviewManifest,
  matrixRowsForPreview,
  renderB3Wordmark,
} from './b3-wordmark.ts';

describe('B3 Signal terminal wordmark', () => {
  test('keeps a stable 23 by 7 logical matrix', () => {
    expect(B3_MATRIX_WIDTH).toBe(23);
    expect(B3_MATRIX_HEIGHT).toBe(7);
    expect(B3_PIXEL_MATRIX).toHaveLength(7);
    expect(B3_PIXEL_MATRIX.every((row) => row.length === 23)).toBe(true);
  });

  test('uses one continuous eleven-cell signal bridge across the two e glyphs', () => {
    const signalCells = B3_PIXEL_MATRIX.flatMap((row, rowIndex) =>
      row.flatMap((cell, columnIndex) => cell === 2 ? [[rowIndex, columnIndex] as const] : []),
    );

    expect(B3_SIGNAL_ROW).toBe(3);
    expect(B3_SIGNAL_COLUMNS).toEqual([6, 16]);
    expect(signalCells).toEqual(
      Array.from({ length: 11 }, (_, index) => [3, index + 6] as const),
    );
  });

  test('renders the full-block mapping at 53 columns by 7 rows', () => {
    const full = renderB3Wordmark('full');

    expect(full.width).toBe(53);
    expect(full.height).toBe(7);
    expect(full.lines).toHaveLength(7);
    expect(full.lines.every((line) => line.plain.length === 53)).toBe(true);
    expect(full.lines[3]?.segments.some((segment) => segment.fg === 'signal' && segment.text === '██████████████████████')).toBe(true);
    expect(full.lines[5]?.plain.endsWith('agent')).toBe(true);
  });

  test('renders the half-block mapping at 30 columns by 4 rows', () => {
    const half = renderB3Wordmark('half');
    const coloredSegments = half.lines.flatMap((line) => line.segments)
      .filter((segment) => segment.fg === 'signal' || segment.bg === 'signal');

    expect(half.width).toBe(30);
    expect(half.height).toBe(4);
    expect(half.lines.every((line) => line.plain.length === 30)).toBe(true);
    expect(coloredSegments.length).toBeGreaterThan(0);
    expect(half.lines[2]?.plain.endsWith('agent')).toBe(true);
  });

  test('uses a deliberate one-line fallback instead of squeezing the matrix', () => {
    const narrow = renderB3Wordmark('narrow');

    expect(narrow.width).toBe(10);
    expect(narrow.height).toBe(1);
    expect(narrow.lines[0]?.plain).toBe('peer━agent');
    expect(narrow.lines[0]?.segments[1]).toEqual({ text: '━', fg: 'signal' });
  });

  test('exports a browser-safe manifest from the same source data', () => {
    const manifest = createB3PreviewManifest();

    expect(manifest.matrix.rows).toEqual(matrixRowsForPreview());
    expect(manifest.matrix.rows[3]?.slice(6, 17)).toBe('===========');
    expect(manifest.variants.full.lines[3]?.plain).toBe(renderB3Wordmark('full').lines[3]?.plain);
    expect(manifest.variants.half.lines[1]?.segments).toEqual(renderB3Wordmark('half').lines[1]?.segments);
    expect(manifest.variants.narrow.lines[0]?.plain).toBe('peer━agent');
  });

  test('keeps the generated browser manifest synchronized with the module', async () => {
    const generated = await Bun.file(new URL('./b3-wordmark.preview.json', import.meta.url)).json();

    expect(generated).toEqual(createB3PreviewManifest());
  });
});
