import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  chipifyImagePathsInText,
  expandImageChipsInText,
  extractImagePathTokens,
  formatImagePathChip,
  isSlashCommandInput,
  loadLocalImageAttachments,
  mergeImagePasteWithExistingDraft,
  registerImagePathKeys,
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

describe('image chips', () => {
  test('formats Qoder-style Image chips with ellipsis for long names', () => {
    expect(formatImagePathChip('/tmp/shot.png')).toBe('[Image shot.png]');
    // basename "4617829306.png" is 14 chars (<=18) so no ellipsis.
    expect(formatImagePathChip('/var/folders/x/otty-paste/4617829306.png'))
      .toBe('[Image 4617829306.png]');
    expect(formatImagePathChip('/tmp/very-long-image-name-abcdef.png'))
      .toBe('[Image ...name-abcdef.png]');
  });

  test('chipifies raw image paths in free-form text', () => {
    const text = '/var/folders/x/otty-paste/image-1.png 看一下为什么有这么大的间距';
    expect(chipifyImagePathsInText(text)).toBe(
      '[Image image-1.png] 看一下为什么有这么大的间距',
    );
  });

  test('does not double-chip already chipped tokens', () => {
    const once = chipifyImagePathsInText('/tmp/a.png hello');
    expect(once).toBe('[Image a.png] hello');
    expect(chipifyImagePathsInText(once)).toBe('[Image a.png] hello');
  });

  test('expands chips back to absolute paths via registry', () => {
    const full = '/var/folders/x/otty-paste/4617829306.png';
    const registry = new Map<string, string>();
    registerImagePathKeys(registry, [full]);
    const chipped = chipifyImagePathsInText(`${full} 看图`);
    expect(chipped).toBe('[Image 4617829306.png] 看图');
    expect(expandImageChipsInText(chipped, registry)).toBe(`${full} 看图`);
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

  test('extracts image paths glued to Chinese without spaces', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    expect(extractImagePathTokens(`${imagePath}看一下`)).toEqual([imagePath]);
    expect(extractImagePathTokens(`看一下${imagePath}`)).toEqual([imagePath]);
    expect(extractImagePathTokens(`看一下${imagePath}间距`)).toEqual([imagePath]);
    expect(stripImagePathsFromText(`${imagePath}看一下`, [imagePath])).toBe('看一下');
    expect(stripImagePathsFromText(`看一下${imagePath}间距`, [imagePath])).toBe('看一下 间距');
  });

  test('chipifies image paths glued to Chinese without spaces', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    expect(chipifyImagePathsInText(`${imagePath}看一下`)).toBe('[Image 4617829306.png]看一下');
    expect(chipifyImagePathsInText(`看一下${imagePath}`)).toBe('看一下[Image 4617829306.png]');
  });

  test('preserves existing draft when an image paste replaces the textarea value', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    expect(mergeImagePasteWithExistingDraft(imagePath, '先帮我看一下这个问题')).toBe(
      `先帮我看一下这个问题 ${imagePath}`,
    );
    expect(mergeImagePasteWithExistingDraft(`${imagePath} 看一下`, '先帮我看一下这个问题')).toBe(
      `先帮我看一下这个问题 ${imagePath} 看一下`,
    );
  });

  test('does not duplicate drafts when normal textarea insertion already preserved text', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    const draft = `先帮我看一下这个问题 ${imagePath}`;
    expect(mergeImagePasteWithExistingDraft(draft, '先帮我看一下这个问题')).toBe(draft);
    expect(mergeImagePasteWithExistingDraft('先帮我看一下这个问题', '先帮我看一下这个问题很长')).toBe('先帮我看一下这个问题');
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

  test('loads images from chip text when path registry is provided', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-tui-image-chip-'));
    const imagePath = path.join(dir, '4617829306.png');
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(imagePath, pngBytes);
    const registry = new Map<string, string>();
    registerImagePathKeys(registry, [imagePath]);
    const chipped = chipifyImagePathsInText(`${imagePath} 看一下`);

    try {
      expect(chipped).toContain('[Image');
      const result = await loadLocalImageAttachments(chipped, { pathByKey: registry });
      expect(result.text).toBe('看一下');
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(result.missingPaths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads glued Chinese image paths into attachments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-tui-image-glued-'));
    const imagePath = path.join(dir, '4617829306.png');
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(imagePath, pngBytes);
    try {
      const result = await loadLocalImageAttachments(`${imagePath}看一下`);
      expect(result.text).toBe('看一下');
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(result.displayContent).toBe('看一下');
      expect(result.missingPaths).toEqual([]);
      // display/send payload must not keep the absolute paste path
      expect(result.displayContent.includes('otty-paste')).toBe(false);
      expect(result.text.includes(imagePath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

});
