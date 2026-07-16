import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import type { TestRendererSetup } from '@opentui/core/testing';

import { MarkdownView } from './markdown-view.tsx';

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

    expect(frame).toContain('▸ Rendered heading');
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
});
