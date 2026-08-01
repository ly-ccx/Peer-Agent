import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { highlightCode } from './codeHighlighter.ts';

describe('highlightCode', () => {
  it('给 diff 增删行输出 addition / deletion token', () => {
    const diff = ['--- a/x.js', '+++ b/x.js', '@@ -1,2 +1,2 @@', '-const a = 1;', '+const a = 2;'].join('\n');
    const result = highlightCode(diff, 'diff');
    assert.equal(result.language, 'diff');
    assert.ok(result.html?.includes('hljs-deletion'));
    assert.ok(result.html?.includes('hljs-addition'));
  });

  it('diff 行级 token 吸收行尾换行，避免 block 着色行后多出空行', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' context', '-const a = 1;', '+const a = 2;'].join('\n');
    const html = highlightCode(diff, 'diff').html ?? '';

    // addition / deletion / meta 在 CSS 里是 display:block，自身已断行。
    // 若 </span> 后还残留 \n，<pre> 会再渲染一次换行 → 视觉上多一行空白。
    assert.equal(/<\/span>\n/.test(html), false);
    // 换行被移入 span 内部，而不是被丢弃。
    assert.ok(html.includes('\n</span>'));
    // 去掉标签后的纯文本必须与源码完全一致，确保没有吞掉或新增字符。
    assert.equal(html.replace(/<[^>]+>/g, ''), diff);
  });

  it('把语言别名收敛为规范 id（ts / js / patch）', () => {
    assert.equal(highlightCode('const a: number = 1;', 'ts').language, 'typescript');
    assert.equal(highlightCode('const a = 1;', 'js').language, 'javascript');
    assert.equal(highlightCode('+added', 'patch').language, 'diff');
  });

  it('容错围栏语言的大小写与附加修饰', () => {
    assert.equal(highlightCode('SELECT 1;', 'SQL').language, 'sql');
    assert.equal(highlightCode('const a = 1;', 'ts title=demo.ts').language, 'typescript');
  });

  it('未指定语言或语言未注册时回退纯文本', () => {
    assert.equal(highlightCode('anything', undefined).html, null);
    assert.equal(highlightCode('anything', '').html, null);
    assert.equal(highlightCode('anything', 'no-such-language').html, null);
  });

  it('超长代码块跳过高亮以保护流式渲染性能', () => {
    const huge = 'const a = 1;\n'.repeat(4000);
    assert.ok(huge.length > 20_000);
    assert.equal(highlightCode(huge, 'javascript').html, null);
  });

  it('对源码做 HTML 转义，不泄漏原始标签', () => {
    const result = highlightCode('const html = "<script>alert(1)</script>";', 'javascript');
    assert.ok(!result.html?.includes('<script>'));
    assert.ok(result.html?.includes('&lt;script&gt;'));
  });

  it('相同输入命中缓存并返回稳定结果', () => {
    const code = 'const cached = true;';
    const first = highlightCode(code, 'typescript');
    const second = highlightCode(code, 'typescript');
    assert.strictEqual(second, first);
  });
});
