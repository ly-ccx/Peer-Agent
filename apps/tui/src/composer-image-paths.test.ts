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
  imagePathChipLabel,
  isSlashCommandInput,
  loadLocalImageAttachments,
  mergeImagePasteWithExistingDraft,
  registerImagePathKeys,
  shortImagePathId,
  stripImagePathsFromText,
} from './composer-image-paths.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function expectChipFor(filePath: string, chip: string): void {
  expect(chip).toBe(formatImagePathChip(filePath));
  expect(chip).toContain(imagePathChipLabel(filePath));
  expect(chip).toMatch(/^\[Image .+ · [0-9a-f]{6}\]$/);
}

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
  test('formats unique Image chips with stable path id', () => {
    const shortPath = '/tmp/shot.png';
    const mediumPath = '/var/folders/x/otty-paste/4617829306.png';
    const longPath = '/tmp/very-long-image-name-abcdef.png';

    expectChipFor(shortPath, formatImagePathChip(shortPath));
    expect(formatImagePathChip(shortPath)).toContain('shot.png · ');
    expect(formatImagePathChip(mediumPath)).toContain('4617829306.png · ');
    expect(formatImagePathChip(longPath)).toContain('...name-abcdef.png · ');
    // Same basename, different dirs → different ids.
    expect(shortImagePathId('/tmp/a/image.png')).not.toBe(shortImagePathId('/tmp/b/image.png'));
    expect(imagePathChipLabel('/tmp/a/image.png')).not.toBe(imagePathChipLabel('/tmp/b/image.png'));
  });

  test('chipifies raw image paths in free-form text', () => {
    const full = '/var/folders/x/otty-paste/image-1.png';
    const text = `${full} 看一下为什么有这么大的间距`;
    expect(chipifyImagePathsInText(text)).toBe(
      `${formatImagePathChip(full)} 看一下为什么有这么大的间距`,
    );
  });

  test('does not double-chip already chipped tokens', () => {
    const full = '/tmp/a.png';
    const once = chipifyImagePathsInText(`${full} hello`);
    expect(once).toBe(`${formatImagePathChip(full)} hello`);
    expect(chipifyImagePathsInText(once)).toBe(`${formatImagePathChip(full)} hello`);
  });

  test('never extracts path tokens from chip labels', () => {
    const chipped = '[Image ...41-F4C365D4.png · ab12cd] 看图';
    expect(extractImagePathTokens(chipped)).toEqual([]);
    // Legacy basename-only chips also produce no path tokens.
    expect(extractImagePathTokens('[Image ...41-F4C365D4.png] 看图')).toEqual([]);
  });

  test('collapses nested Image chips instead of leaving broken tokens', () => {
    const nested = '[Image [Image ...41-F4C365D4.png]] 有个诉求';
    // Inner chip is not a path token; outer cleanup keeps a single chip-ish form.
    const result = chipifyImagePathsInText(nested);
    expect(result.includes('[Image [Image')).toBe(false);
    expect(result).toContain('有个诉求');
  });

  test('compacts a full-path chip into a unique short label without nesting', () => {
    const full = '/var/folders/x/otty-paste/very-long-prefix-41-F4C365D4.png';
    const fullPathChip = `[Image ${full}]`;
    expect(chipifyImagePathsInText(fullPathChip)).toBe(formatImagePathChip(full));
    expect(extractImagePathTokens(fullPathChip)).toEqual([]);
  });

  test('expands chips back to absolute paths via registry', () => {
    const full = '/var/folders/x/otty-paste/4617829306.png';
    const registry = new Map<string, string>();
    registerImagePathKeys(registry, [full]);
    const chipped = chipifyImagePathsInText(`${full} 看图`);
    expect(chipped).toBe(`${formatImagePathChip(full)} 看图`);
    expect(expandImageChipsInText(chipped, registry)).toBe(`${full} 看图`);
  });

  test('keeps two same-basename chips distinct and expandable', () => {
    const a = '/tmp/a/image.png';
    const b = '/tmp/b/image.png';
    const registry = new Map<string, string>();
    registerImagePathKeys(registry, [a, b]);
    const chipped = chipifyImagePathsInText(`${a}\n${b}`);
    expect(chipped).toBe(`${formatImagePathChip(a)}\n${formatImagePathChip(b)}`);
    expect(formatImagePathChip(a)).not.toBe(formatImagePathChip(b));
    expect(expandImageChipsInText(chipped, registry)).toBe(`${a}\n${b}`);
    // Soft basename key must not overwrite the first path.
    expect(registry.get('image.png')).toBe(path.resolve(a));
    expect(registry.get(imagePathChipLabel(a))).toBe(path.resolve(a));
    expect(registry.get(imagePathChipLabel(b))).toBe(path.resolve(b));
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
    expect(chipifyImagePathsInText(`${imagePath}看一下`)).toBe(`${formatImagePathChip(imagePath)}看一下`);
    expect(chipifyImagePathsInText(`看一下${imagePath}`)).toBe(`看一下${formatImagePathChip(imagePath)}`);
  });

  test('loads one image and strips its path from text', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-img-'));
    const imagePath = path.join(dir, 'shot.png');
    try {
      await writeFile(imagePath, PNG);
      const result = await loadLocalImageAttachments(`${imagePath} 说明一下`);
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mimeType).toBe('image/png');
      expect(result.images[0]?.url.startsWith('data:image/png;base64,')).toBe(true);
      expect(result.text).toBe('说明一下');
      expect(result.missingPaths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads chipped image via path registry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-img-'));
    const imagePath = path.join(dir, '4617829306.png');
    try {
      await writeFile(imagePath, PNG);
      const registry = new Map<string, string>();
      registerImagePathKeys(registry, [imagePath]);
      const chipped = chipifyImagePathsInText(`${imagePath} 看一下`);
      expect(chipped).toBe(`${formatImagePathChip(imagePath)} 看一下`);
      const result = await loadLocalImageAttachments(chipped, { pathByKey: registry });
      expect(result.images).toHaveLength(1);
      expect(result.text).toBe('看一下');
      expect(result.missingPaths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads multiple same-basename images as separate attachments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-img-multi-'));
    const aDir = path.join(dir, 'a');
    const bDir = path.join(dir, 'b');
    await writeFile(path.join(dir, '.keep'), '');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(aDir, { recursive: true });
    await mkdir(bDir, { recursive: true });
    const p1 = path.join(aDir, 'image.png');
    const p2 = path.join(bDir, 'image.png');
    try {
      await writeFile(p1, PNG);
      await writeFile(p2, PNG);

      // Sequential paste simulation (matches app.tsx applyImageChips).
      const registry = new Map<string, string>();
      let draft = '';
      for (const paste of [p1, p2]) {
        const value = draft ? `${draft}\n${paste}` : paste;
        const chipped = chipifyImagePathsInText(value);
        const rawPaths = extractImagePathTokens(value);
        if (rawPaths.length > 0) registerImagePathKeys(registry, rawPaths);
        draft = chipped;
      }

      expect(draft).toBe(`${formatImagePathChip(p1)}\n${formatImagePathChip(p2)}`);
      const result = await loadLocalImageAttachments(draft, { pathByKey: registry });
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe('');
      expect(result.displayContent).toBe('[Images × 2]');
      expect(result.missingPaths).toEqual([]);
      // Outbound body must not retain local path strings.
      expect(result.text.includes(p1)).toBe(false);
      expect(result.text.includes(p2)).toBe(false);
      expect(result.text.includes('/image.png')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads multiple distinct images and keeps user text only', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-img-multi2-'));
    const p1 = path.join(dir, 'one.png');
    const p2 = path.join(dir, 'two-very-long-image-name.png');
    try {
      await writeFile(p1, PNG);
      await writeFile(p2, PNG);
      const registry = new Map<string, string>();
      const raw = `hello\n${p1}\n${p2}`;
      const chipped = chipifyImagePathsInText(raw);
      registerImagePathKeys(registry, extractImagePathTokens(raw));
      const result = await loadLocalImageAttachments(chipped, { pathByKey: registry });
      expect(result.images).toHaveLength(2);
      expect(result.text).toBe('hello');
      expect(result.displayContent).toBe('hello');
      expect(result.missingPaths).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads multi-image single paste without path residue', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'peer-img-multi3-'));
    const p1 = path.join(dir, 'a.png');
    const p2 = path.join(dir, 'b.png');
    const p3 = path.join(dir, 'c.png');
    try {
      await writeFile(p1, PNG);
      await writeFile(p2, PNG);
      await writeFile(p3, PNG);
      const registry = new Map<string, string>();
      const raw = `${p1}\n${p2}\n${p3}`;
      const chipped = chipifyImagePathsInText(raw);
      registerImagePathKeys(registry, extractImagePathTokens(raw));
      const result = await loadLocalImageAttachments(chipped, { pathByKey: registry });
      expect(result.images).toHaveLength(3);
      expect(result.text).toBe('');
      expect(result.displayContent).toBe('[Images × 3]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mergeImagePasteWithExistingDraft', () => {
  test('appends a newly pasted path without wiping existing chips', () => {
    const previousDraft = 'sad [Image 46-B9694CBE.png · ab12cd]';
    const imagePath2 = '/var/folders/x/otty-paste/new-image.png';
    // Signature: mergeImagePasteWithExistingDraft(nextText, previousDraft)
    const nextText = `sad ${imagePath2}`;
    const merged = mergeImagePasteWithExistingDraft(nextText, previousDraft);
    expect(merged).toContain('[Image 46-B9694CBE.png · ab12cd]');
    expect(merged).toContain(imagePath2);
  });
});

describe('formatUserMessageBody', () => {
  test('keeps text and image label separate for pure-image turns', () => {
    const body = formatUserMessageBody('', [{ url: 'data:image/png;base64,xx' }]);
    expect(body.imageLabel).toBe('[Image]');
    expect(body.text).toBe('');
  });

  test('keeps multi-image label when content is empty', () => {
    const body = formatUserMessageBody('', [
      { url: 'data:image/png;base64,aa' },
      { url: 'data:image/png;base64,bb' },
    ]);
    expect(body.imageLabel).toBe('[Images × 2]');
  });
});
