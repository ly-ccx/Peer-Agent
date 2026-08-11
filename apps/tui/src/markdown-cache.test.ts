import { describe, expect, test } from 'bun:test';

import {
  highlightCodeCached,
  parseMarkdownBlocksCached,
} from './markdown-view.tsx';

describe('markdown render caches', () => {
  test('reuses parsed blocks for identical completed content', () => {
    const markdown = `# cached-${Date.now()}\n\nparagraph`;
    const first = parseMarkdownBlocksCached(markdown);
    const second = parseMarkdownBlocksCached(markdown);
    expect(second).toBe(first);
  });

  test('invalidates parsed blocks when streaming content changes', () => {
    const prefix = `# stream-${Date.now()}\n\n`;
    const first = parseMarkdownBlocksCached(`${prefix}a`);
    const second = parseMarkdownBlocksCached(`${prefix}ab`);
    expect(second).not.toBe(first);
  });

  test('reuses highlighted tokens by language and source', () => {
    const source = `const cache_${Date.now()} = 1;`;
    const first = highlightCodeCached(source, 'typescript');
    const second = highlightCodeCached(source, 'typescript');
    const otherLanguage = highlightCodeCached(source, 'python');
    expect(second).toBe(first);
    expect(otherLanguage).not.toBe(first);
  });
});
