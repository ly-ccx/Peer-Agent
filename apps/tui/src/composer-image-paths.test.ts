import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  chipifyImagePathsInText,
  expandImageChipsInText,
  extractImagePathTokens,
  formatImagePathChip,
  formatUserMessageBody,
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

  test('does not duplicate content when pasting image mid-text (caret insertion)', () => {
    const imagePath1 = '/var/folders/x/otty-paste/46-B9694CBE.png';
    const imagePath2 = '/var/folders/x/otty-paste/49-1A896806.png';
    // Previous draft had text + one image chip
    const previousDraft = `sad [Image 46-B9694CBE.png]`;
    // User pasted a new image path in the middle (between "sad" and the chip)
    const nextText = `sad ${imagePath2} [Image 46-B9694CBE.png]`;
    // Should NOT merge — all previous segments are still present in nextText
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
  });

  test('does not duplicate content when pasting image between two text segments', () => {
    const imagePath = '/var/folders/x/otty-paste/49-1A896806.png';
    const previousDraft = 'hello world';
    // User pasted image path in the middle of the text
    const nextText = `hello ${imagePath} world`;
    // All segments of previousDraft ("hello" and "world") are present
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
  });

  test('still merges when paste fully replaces textarea (no previous content remains)', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    // Previous draft is completely gone — paste replaced everything
    expect(mergeImagePasteWithExistingDraft(imagePath, 'completely different text')).toBe(
      `completely different text ${imagePath}`,
    );
  });

  test('does not duplicate when previous draft has image chip and paste splits text around it', () => {
    const imagePath = '/var/folders/x/otty-paste/49-1A896806.png';
    const previousDraft = 'sad [Image 46-B9694CBE.png] mode_agent_access';
    // Paste inserted in the middle, splitting the draft
    const nextText = `sad ${imagePath} [Image 46-B9694CBE.png] mode_agent_access`;
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
  });

  test('does not duplicate content when pasting image mid-text (caret insertion)', () => {
    const imagePath1 = '/var/folders/x/otty-paste/46-B9694CBE.png';
    const imagePath2 = '/var/folders/x/otty-paste/49-1A896806.png';
    // Previous draft had text + one image chip
    const previousDraft = `sad [Image 46-B9694CBE.png]`;
    // User pasted a new image path in the middle (between "sad" and the chip)
    const nextText = `sad ${imagePath2} [Image 46-B9694CBE.png]`;
    // Should NOT merge — all previous segments are still present in nextText
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
  });

  test('does not duplicate content when pasting image between two text segments', () => {
    const imagePath = '/var/folders/x/otty-paste/49-1A896806.png';
    const previousDraft = 'hello world';
    // User pasted image path in the middle of the text
    const nextText = `hello ${imagePath} world`;
    // All segments of previousDraft ("hello" and "world") are present
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
  });

  test('still merges when paste fully replaces textarea (no previous content remains)', () => {
    const imagePath = '/var/folders/x/otty-paste/4617829306.png';
    // Previous draft is completely gone — paste replaced everything
    expect(mergeImagePasteWithExistingDraft(imagePath, 'completely different text')).toBe(
      `completely different text ${imagePath}`,
    );
  });

  test('does not duplicate when previous draft has image chip and paste splits text around it', () => {
    const imagePath = '/var/folders/x/otty-paste/49-1A896806.png';
    const previousDraft = 'sad [Image 46-B9694CBE.png] mode_agent_access';
    // Paste inserted in the middle, splitting the draft
    const nextText = `sad ${imagePath} [Image 46-B9694CBE.png] mode_agent_access`;
    expect(mergeImagePasteWithExistingDraft(nextText, previousDraft)).toBe(nextText);
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

  test('formatUserMessageBody keeps typed text and adds image chip', () => {
    const withText = formatUserMessageBody('看一下', [{ url: 'data:image/png;base64,abc' }]);
    expect(withText.text).toBe('看一下');
    expect(withText.imageLabel).toBe('[Image]');

    const pureImage = formatUserMessageBody('', [{ url: 'data:image/png;base64,abc' }]);
    expect(pureImage.text).toBe('');
    expect(pureImage.imageLabel).toBe('[Image]');

    const placeholderOnly = formatUserMessageBody('[image: shot.png]', [
      { url: 'data:image/png;base64,abc' },
    ]);
    expect(placeholderOnly.text).toBe('');
    expect(placeholderOnly.imageLabel).toBe('[Image]');

    const multi = formatUserMessageBody('两张图', [
      { url: 'data:image/png;base64,a' },
      { url: 'data:image/png;base64,b' },
    ]);
    expect(multi.text).toBe('两张图');
    expect(multi.imageLabel).toBe('[Images × 2]');
  });

});
