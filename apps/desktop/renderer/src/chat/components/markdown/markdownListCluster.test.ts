import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMarkdownBlocks } from './markdownParser.ts';

const listsOf = (markdown: string) =>
  parseMarkdownBlocks(markdown).filter((block) => block.type === 'list');

const typesOf = (markdown: string) => parseMarkdownBlocks(markdown).map((block) => block.type);

test('a blank-line-separated ordered list stays one block', () => {
  // 模型常用「空行 + 编号」写步骤；逐条拆开会在每条之间撑出一整行空行。
  const lists = listsOf('1. 收尾去重\n\n2. 完成修复\n\n3. 补齐双仓');
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0], {
    type: 'list',
    ordered: true,
    start: 1,
    items: ['收尾去重', '完成修复', '补齐双仓'],
  });
});

test('a blank-line-separated bullet list stays one block', () => {
  const lists = listsOf('- item one\n\n- item two');
  assert.equal(lists.length, 1);
  assert.deepEqual(
    { ordered: (lists[0] as { ordered: boolean }).ordered, items: lists[0]?.items },
    { ordered: false, items: ['item one', 'item two'] },
  );
});

test('adjacent items still merge and the start number is preserved', () => {
  const lists = listsOf('1. alpha\n2. beta');
  assert.equal(lists.length, 1);
  assert.deepEqual(lists[0], { type: 'list', ordered: true, start: 1, items: ['alpha', 'beta'] });
  assert.equal((listsOf('3. third\n5. fifth')[0] as { start: number }).start, 3);
});

test('a different list type after a blank line is not merged', () => {
  const lists = listsOf('1. ordered item\n\n- unordered item');
  assert.equal(lists.length, 2);
  assert.deepEqual(lists.map((list) => (list as { ordered: boolean }).ordered), [true, false]);
});

test('a paragraph, code block or heading after a blank line still ends the list', () => {
  assert.deepEqual(typesOf('1. ordered item\n\n普通段落文字。'), ['list', 'paragraph']);
  assert.deepEqual(typesOf('1. step one\n2. step two\n\n```js\ncode();\n```'), ['list', 'code']);
  assert.deepEqual(typesOf('1. step one\n\n## 标题'), ['list', 'heading']);
});

test('the reported reply shape parses as two lists and two paragraphs', () => {
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
  const lists = listsOf(markdown);
  assert.equal(lists.length, 2);
  assert.equal((lists[0] as { items: readonly string[] }).items.length, 3);
  assert.equal((lists[1] as { items: readonly string[] }).items.length, 2);
  assert.equal(typesOf(markdown).filter((type) => type === 'paragraph').length, 2);
});
