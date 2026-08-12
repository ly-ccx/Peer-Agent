import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMarkdownLink, safeExternalHref } from './inlineMarkdownLinks.ts';

describe('findMarkdownLink', () => {
  it('完整识别标签含行内代码、目标为工作区相对路径的链接', () => {
    const source = '完整产品文档已落在：[`design/product/task-worktree-delivery-product-design.md`](design/product/task-worktree-delivery-product-design.md)';
    const token = findMarkdownLink(source);

    assert.deepEqual(token, {
      start: source.indexOf('['),
      end: source.length,
      label: '`design/product/task-worktree-delivery-product-design.md`',
      destination: 'design/product/task-worktree-delivery-product-design.md',
    });
  });

  it('允许 destination 包含配对括号', () => {
    const source = '[文档](docs/feature_(draft).md)';
    assert.deepEqual(findMarkdownLink(source), {
      start: 0,
      end: source.length,
      label: '文档',
      destination: 'docs/feature_(draft).md',
    });
  });

  it('跳过图片和不完整链接', () => {
    assert.equal(findMarkdownLink('![截图](assets/demo.png)'), null);
    assert.equal(findMarkdownLink('[未完成](docs/demo.md'), null);
  });
});

describe('safeExternalHref', () => {
  it('只允许受支持的外部链接协议', () => {
    assert.equal(safeExternalHref('https://example.com/docs'), 'https://example.com/docs');
    assert.equal(safeExternalHref('mailto:peer@example.com'), 'mailto:peer@example.com');
    assert.equal(safeExternalHref('javascript:alert(1)'), null);
    assert.equal(safeExternalHref('design/product/doc.md'), null);
  });
});
