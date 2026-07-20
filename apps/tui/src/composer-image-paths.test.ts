import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  extractImagePathTokens,
  isSlashCommandInput,
  loadLocalImageAttachments,
  stripImagePathsFromText,
} from './composer-image-paths.ts';

describe('isSlashCommandInput', () => {
  test('keeps real slash commands', () => {
    expect(isSlashCommandInput('/help')).toBe(true);
    expect(isSlashCommandInput('/model gpt')).toBe(true);
    expect(isSlashCommandInput('/clear')).toBe(true);
  });

  test('does not treat absolute image paths as slash commands', () => {
    expect(isSlashCommandInput('/var/folders/24/otty-paste/image.png')).toBe(false);
    expect(isSlashCommandInput('/Users/me/Desktop/shot.jpg 看一下间距')).toBe(false);
    expect(isSlashCommandInput('/tmp/a.webp')).toBe(false);
  });
});

describe('extractImagePathTokens + loadLocalImageAttachments', () => {
  test('extracts local image paths from free-form text', () => {
    const text = '/var/folders/x/otty-paste/image-1.png 看一下为什么有这么大的间距';
    expect(extractImagePathTokens(text)).toEqual([
      '/var/folders/x/otty-paste/image-1.png',
    ]);
    expect(stripImagePathsFromText(text, ['/var/folders/x/otty-paste/image-1.png']))
      .toBe('看一下为什么有这么大的间距');
  });

  test('loads existing image files into data-url MessageImage payloads', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-tui-image-'));
    const imagePath = path.join(dir, 'shot.png');
    // Minimal valid-ish PNG header bytes are enough for attachment loading.
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(imagePath, pngBytes);

    try {
      const result = await loadLocalImageAttachments(`${imagePath} 说明一下`);
      expect(result.text).toBe('说明一下');
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mimeType).toBe('image/png');
      expect(result.images[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(result.missingPaths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
