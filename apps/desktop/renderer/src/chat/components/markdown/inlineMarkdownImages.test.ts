import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMarkdownImage, findMarkdownLink } from './inlineMarkdownLinks.ts';

describe('findMarkdownImage', () => {
  it('识别相对路径图片语法，不再把 ![alt](src) 丢掉', () => {
    const source =
      '![Gate A 空会话内嵌接通](design/product/first-run-shots/01-gate-a-inline-connect.png)';
    const token = findMarkdownImage(source);

    assert.ok(token);
    assert.deepEqual(token, {
      start: 0,
      end: source.length,
      alt: 'Gate A 空会话内嵌接通',
      destination: 'design/product/first-run-shots/01-gate-a-inline-connect.png',
    });
    assert.equal(findMarkdownLink(source), null);
  });

  it('允许 destination 与括号之间有空白', () => {
    const source = '见截图：![工作台] (design/product/first-run-shots/03-workbench-zero-task.png)';
    const token = findMarkdownImage(source);

    assert.ok(token);
    assert.equal(token.alt, '工作台');
    assert.equal(token.destination, 'design/product/first-run-shots/03-workbench-zero-task.png');
    assert.equal(token.start, source.indexOf('!['));
    assert.equal(token.end, source.length);
  });

  it('跳过转义的图片语法', () => {
    const source = '\\![截图](assets/demo.png) 后面才是真图 ![真图](assets/real.png)';
    const token = findMarkdownImage(source);

    assert.ok(token);
    assert.equal(token.alt, '真图');
    assert.equal(token.destination, 'assets/real.png');
    assert.equal(token.start, source.indexOf('![真图]'));
  });
});
