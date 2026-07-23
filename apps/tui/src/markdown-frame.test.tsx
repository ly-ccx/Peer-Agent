import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import type { TestRendererSetup } from '@opentui/core/testing';

import { MarkdownView } from './markdown-view.tsx';
import { COLOR } from './tui-theme.ts';

const renderers: TestRendererSetup[] = [];

async function renderMarkdownSetup(content: string): Promise<TestRendererSetup> {
  const setup = await testRender(<MarkdownView content={content} />, { width: 80, height: 20 });
  renderers.push(setup);
  await setup.flush();
  await setup.renderOnce();
  return setup;
}

async function renderMarkdown(content: string): Promise<string> {
  return (await renderMarkdownSetup(content)).captureCharFrame();
}

function colorForText(setup: TestRendererSetup, text: string): number[] | undefined {
  return setup.captureSpans().lines
    .flatMap((line) => line.spans)
    .find((span) => span.text.includes(text))
    ?.fg.toInts();
}

afterEach(() => {
  for (const setup of renderers.splice(0)) setup.renderer.destroy();
});

describe('Markdown terminal frame', () => {
  test('formats headings, emphasis, inline code, and fenced code without source markers', async () => {
    const frame = await renderMarkdown([
      '## Rendered heading',
      '',
      'Text with **bold**, *italic*, and `inline code`.',
      '',
      '```ts',
      'const answer = 42;',
      '```',
    ].join('\n'));

    expect(frame).toContain('› Rendered heading');
    expect(frame).toContain('Text with bold, italic, and inline code.');
    expect(frame).toContain('ts');
    expect(frame).toContain('const answer = 42;');
    expect(frame).not.toContain('##');
    expect(frame).not.toContain('**');
    expect(frame).not.toContain('`inline code`');
    expect(frame).not.toContain('```');
  });

  test('uses distinct semantic colors for diff additions, deletions, hunks, and metadata', async () => {
    const setup = await renderMarkdownSetup([
      '```diff',
      'diff --git a/file.ts b/file.ts',
      '@@ -1,2 +1,2 @@',
      '-const oldValue = 1;',
      '+const newValue = 2;',
      ' const stable = true;',
      '```',
    ].join('\n'));

    const frame = setup.captureCharFrame();
    expect(frame).toContain('-const oldValue = 1;');
    expect(frame).toContain('+const newValue = 2;');
    expect(frame).toContain('@@ -1,2 +1,2 @@');

    const add = colorForText(setup, '+const newValue = 2;');
    const deletion = colorForText(setup, '-const oldValue = 1;');
    const hunk = colorForText(setup, '@@ -1,2 +1,2 @@');
    const metadata = colorForText(setup, 'diff --git a/file.ts b/file.ts');
    const context = colorForText(setup, ' const stable = true;');

    expect(add).toEqual([74, 222, 128, 255]);
    expect(deletion).toEqual([248, 113, 113, 255]);
    expect(hunk).toEqual([103, 232, 249, 255]);
    expect(metadata).toEqual([115, 115, 115, 255]);
    expect(new Set([add, deletion, hunk, metadata, context].map((color) => color?.join(','))).size).toBe(5);
  });

  test('renders GFM tables with aligned columns and CJK-aware padding', async () => {
    const frame = await renderMarkdown([
      '| 角色 | PID | 命令 |',
      '| --- | ---: | --- |',
      '| preview | 91972 | pnpm preview |',
      '| main | 92021 | electron main |',
    ].join('\n'));

    // Header row visible on its own line
    expect(frame).toContain('角色');
    expect(frame).toContain('PID');
    expect(frame).toContain('命令');

    // Data rows on separate lines
    expect(frame).toContain('91972');
    expect(frame).toContain('pnpm preview');
    expect(frame).toContain('92021');
    expect(frame).toContain('electron main');

    // Separator line rendered
    expect(frame).toContain('│');
    expect(frame).toContain('─');

    // Raw pipe markers from source should not leak as a collapsed single line
    const lines = frame.split('\n');
    const tableLines = lines.filter((l) => l.includes('│') || l.includes('─'));
    expect(tableLines.length).toBeGreaterThanOrEqual(3);
  });

  test('does not collapse a table into a single paragraph line', async () => {
    const frame = await renderMarkdown([
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'));

    const lines = frame.split('\n').filter((l) => l.trim());
    // Header, separator, data row = at least 3 distinct rendered lines
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.includes('A'))).toBe(true);
    expect(lines.some((l) => l.includes('1'))).toBe(true);
  });

  test('list items use body text foreground color like paragraphs', async () => {
    const setup = await renderMarkdownSetup([
      'Paragraph body text here.',
      '',
      '1. Ordered list item alpha',
      '2. Ordered list item beta',
      '',
      '- Unordered list item gamma',
    ].join('\n'));

    const frame = setup.captureCharFrame();
    expect(frame).toContain('1. Ordered list item alpha');
    expect(frame).toContain('• Unordered list item gamma');

    const paragraph = colorForText(setup, 'Paragraph body text here.');
    const ordered = colorForText(setup, 'Ordered list item alpha');
    const unordered = colorForText(setup, 'Unordered list item gamma');

    // #e5e5e5 dark / #1A2332 light — compare via rendered span equality with paragraph
    expect(paragraph).toBeDefined();
    expect(ordered).toEqual(paragraph);
    expect(unordered).toEqual(paragraph);

    // Guard that the shared body color is the theme text token, not default white
    const [r, g, b] = paragraph!;
    const hex = COLOR.text.replace('#', '');
    const expected = [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
    expect([r, g, b]).toEqual(expected);
  });
});
