import { describe, expect, test } from 'bun:test';

import { parseMarkdownBlocks } from './markdown-view.tsx';

const lists = (markdown: string) =>
  parseMarkdownBlocks(markdown).filter((block): block is Extract<typeof block, { type: 'list' }> => block.type === 'list');

const types = (markdown: string) => parseMarkdownBlocks(markdown).map((block) => block.type);

describe('markdown list clustering across blank lines', () => {
  test('keeps a blank-line-separated ordered list as one block', () => {
    // 模型常用「空行 + 编号」写步骤；逐条拆开会在每条之间撑出一整行空行。
    const blocks = lists('1. 收尾去重\n\n2. 完成修复\n\n3. 补齐双仓');
    expect(blocks).toHaveLength(1);
    expect({ ordered: blocks[0]!.ordered, start: blocks[0]!.start }).toEqual({ ordered: true, start: 1 });
    expect(blocks[0]!.items).toEqual(['收尾去重', '完成修复', '补齐双仓']);
  });

  test('keeps a blank-line-separated bullet list as one block', () => {
    const blocks = lists('- item one\n\n- item two');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.ordered).toBe(false);
    expect(blocks[0]!.items).toEqual(['item one', 'item two']);
  });

  test('still merges adjacent items and preserves the start number', () => {
    const blocks = lists('1. alpha\n2. beta');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.items).toEqual(['alpha', 'beta']);
    expect(lists('3. third\n5. fifth')[0]).toMatchObject({ start: 3 });
  });

  test('does not merge a different list type after a blank line', () => {
    const blocks = lists('1. ordered item\n\n- unordered item');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.ordered).toBe(true);
    expect(blocks[1]!.ordered).toBe(false);
  });

  test('a paragraph, code block or heading after a blank line still ends the list', () => {
    expect(types('1. ordered item\n\n普通段落文字。')).toEqual(['list', 'paragraph']);
    expect(types('1. step one\n2. step two\n\n```js\ncode();\n```')).toEqual(['list', 'code']);
    expect(types('1. step one\n\n## 标题')).toEqual(['list', 'heading']);
    expect(lists('1. ordered item\n\n普通段落文字。')).toHaveLength(1);
  });

  test('handles the reported reply shape end to end', () => {
    const markdown = [
      '三条可以这样收尾。',
      '',
      '1. 第一条',
      '',
      '2. 第二条',
      '',
      '3. 第三条',
      '',
      '我核到的事实：',
      '',
      '- Peer-Agent: HEAD',
      '- Peer-Knowledge: HEAD',
    ].join('\n');
    const blocks = lists(markdown);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.items).toHaveLength(3);
    expect(blocks[1]!.items).toHaveLength(2);
    expect(types(markdown).filter((type) => type === 'paragraph')).toHaveLength(2);
  });
});
