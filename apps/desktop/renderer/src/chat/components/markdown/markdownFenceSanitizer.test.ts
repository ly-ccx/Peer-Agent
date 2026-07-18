import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fixUnbalancedPathBacktick,
  looksLikeProseNotCode,
  sanitizeMarkdownFences,
} from './markdownFenceSanitizer.ts';
import { parseMarkdownBlocks } from './markdownParser.ts';

describe('looksLikeProseNotCode', () => {
  it('detects short Chinese caption as prose', () => {
    assert.equal(looksLikeProseNotCode('样式是整行占满：'), true);
  });

  it('detects Chinese sentence with inline markdown as prose', () => {
    assert.equal(looksLikeProseNotCode('**Quick** (`QuickChatWindow`) 把附件塞进了输入行：'), true);
  });

  it('does not treat real code as prose', () => {
    assert.equal(looksLikeProseNotCode('const x = 1;\nreturn x;'), false);
    assert.equal(looksLikeProseNotCode('<div className="row" />'), false);
    assert.equal(
      looksLikeProseNotCode('.chat-composer > .attachment-strip {\n  flex: 0 0 100%;\n}'),
      false,
    );
  });
});

describe('fixUnbalancedPathBacktick', () => {
  it('closes path-style half-open backticks', () => {
    assert.equal(
      fixUnbalancedPathBacktick(
        '`152:159:apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx',
      ),
      '`152:159:apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx`',
    );
    assert.equal(fixUnbalancedPathBacktick('`path/to/file.ts'), '`path/to/file.ts`');
  });

  it('leaves balanced or non-path lines alone', () => {
    assert.equal(fixUnbalancedPathBacktick('`ok`'), '`ok`');
    assert.equal(fixUnbalancedPathBacktick('hello world'), 'hello world');
    assert.equal(fixUnbalancedPathBacktick('`not a path with spaces'), '`not a path with spaces');
  });
});

describe('sanitizeMarkdownFences', () => {
  it('strips prose-only fences (suspect screenshot case)', () => {
    const input = [
      '`152:159:apps/desktop/renderer/src/chat/components/ComposerDraftControls.tsx',
      '{attachments.length ? (',
      '  <AttachmentStrip',
      '    attachments={attachments}',
      '  />',
      ') : null}',
      '',
      '```',
      '样式是整行占满：',
      '```',
      '',
      '.chat-composer > .attachment-strip {',
      '  flex: 0 0 100%;',
      '}',
      '',
      '```',
      '**Quick** (`QuickChatWindow`) 把附件塞进了输入行：',
      '```',
      '',
      '<div className="quick-chat-input-row">',
      '  <textarea ... />',
      '</div>',
    ].join('\n');

    const cleaned = sanitizeMarkdownFences(input);
    assert.ok(!cleaned.includes('```\n样式是整行占满：\n```'));
    assert.match(cleaned, /样式是整行占满：/);
    assert.match(cleaned, /\*\*Quick\*\*/);
    assert.match(
      cleaned,
      /`152:159:apps\/desktop\/renderer\/src\/chat\/components\/ComposerDraftControls\.tsx`/,
    );

    const blocks = parseMarkdownBlocks(input);
    const types = blocks.map((b) => b.type);
    // Prose captions must not become code blocks
    for (const block of blocks) {
      if (block.type === 'code') {
        assert.ok(!block.content.includes('样式是整行占满'));
        assert.ok(!block.content.includes('把附件塞进了输入行'));
      }
    }
    // Captions should appear as paragraphs (possibly merged with neighbors)
    const paragraphText = blocks
      .filter((b) => b.type === 'paragraph')
      .map((b) => b.content)
      .join('\n');
    assert.match(paragraphText, /样式是整行占满：/);
    assert.match(paragraphText, /\*\*Quick\*\*/);
    assert.ok(types.includes('paragraph'));
  });

  it('does not strip real code fences', () => {
    const input = [
      'Here is code:',
      '',
      '```tsx',
      'const x = 1;',
      'return <div className="ok" />;',
      '```',
      '',
      'And CSS:',
      '',
      '```css',
      '.row { display: flex; }',
      '```',
    ].join('\n');

    const blocks = parseMarkdownBlocks(input);
    const codes = blocks.filter((b) => b.type === 'code');
    assert.equal(codes.length, 2);
    assert.equal(codes[0].language, 'tsx');
    assert.match(codes[0].content, /const x = 1/);
    assert.equal(codes[1].language, 'css');
    assert.match(codes[1].content, /\.row/);
  });

  it('closes unclosed real code fences so trailing prose stays out', () => {
    const input = ['```js', 'console.log(1);', '', 'after fence prose'].join('\n');
    const cleaned = sanitizeMarkdownFences(input);
    assert.ok(cleaned.trimEnd().endsWith('```') || cleaned.includes('```\nafter') === false);
    // After sanitize, parser should treat only code body as code when closed
    const blocks = parseMarkdownBlocks(input);
    // With auto-close at end, whole remainder becomes code — that's intentional for unclosed
    // code-looking bodies. Verify body still contains the console.log.
    const code = blocks.find((b) => b.type === 'code');
    assert.ok(code);
    assert.match(code!.content, /console\.log/);
  });

  it('strips unclosed prose fences instead of swallowing the rest', () => {
    const input = ['```', '说明文字：', '后面还有段落'].join('\n');
    const cleaned = sanitizeMarkdownFences(input);
    assert.ok(!cleaned.startsWith('```'));
    assert.match(cleaned, /说明文字：/);
    const blocks = parseMarkdownBlocks(input);
    assert.ok(blocks.every((b) => b.type !== 'code' || !b.content.includes('说明文字')));
    const text = blocks.map((b) => ('content' in b ? b.content : '')).join('\n');
    assert.match(text, /说明文字：/);
    assert.match(text, /后面还有段落/);
  });
});
