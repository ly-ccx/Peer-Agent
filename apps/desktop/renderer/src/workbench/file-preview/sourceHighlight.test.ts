import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightCode, highlightSourceCode, MAX_SOURCE_HIGHLIGHT_CHARS } from '../../chat/components/markdown/codeHighlighter.ts';
import { highlightSourceLines, splitHighlightedHtmlByLine } from './sourceHighlight.ts';

function decodeHighlightedLine(html: string): string {
  const entities: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'", '&amp;': '&' };
  return html.replace(/<\/?span\b[^>]*>/g, '').replace(/&(?:lt|gt|quot|#x27|#39|amp);/g, (entity) => entities[entity]);
}

for (const extension of ['ts', 'tsx']) {
  for (const size of ['short', 'long']) {
    test(`source parity ${extension}/${size}: tokens, escaped text, lines and chat budget`, () => {
      const declaration = extension === 'tsx'
        ? 'export const View = () => <div title="a & b">{"<script>"}</div>;'
        : 'export const value: string = "<script> & value";';
      const source = ['/* multiline', ' * preserved */', declaration, '', '// tail', ''].join('\n').repeat(size === 'long' ? 400 : 1);
      assert.equal(source.length > 20_000, size === 'long');
      const result = highlightSourceLines(source, extension);
      assert.equal(result.language, 'typescript');
      assert.match(result.lines.join('\n'), /hljs-keyword/);
      assert.match(result.lines.join('\n'), /hljs-comment/);
      assert.doesNotMatch(result.lines.join('\n'), /<script>|<div/);
      assert.deepEqual(result.lines.map(decodeHighlightedLine), source.split('\n'));
      assert.equal(highlightCode(source, extension).html === null, size === 'long');
    });
  }
}

test('source limit includes boundary; oversized fallback keeps original text and does not poison chat cache', () => {
  const boundary = '// ' + 'x'.repeat(MAX_SOURCE_HIGHLIGHT_CHARS - 3);
  assert.equal(highlightSourceCode(boundary, 'ts').language, 'typescript');
  const beyond = boundary + '\n';
  assert.deepEqual(highlightSourceLines(beyond, 'ts'), { language: null, lines: beyond.split('\n') });
  assert.equal(highlightSourceCode('x', 'not-a-language').html, null);
  const small = 'const cachedSource = true;';
  const chat = highlightCode(small, 'ts');
  assert.notStrictEqual(highlightSourceCode(small, 'ts'), chat);
  assert.strictEqual(highlightCode(small, 'ts'), chat);
});

test('splits highlighted html while preserving tokens that span lines', () => {
  const html = '<span class="hljs-comment">/*\n * note\n */</span>\nconst x = 1;';
  assert.deepEqual(splitHighlightedHtmlByLine(html), [
    '<span class="hljs-comment">/*</span>',
    '<span class="hljs-comment"> * note</span>',
    '<span class="hljs-comment"> */</span>',
    'const x = 1;',
  ]);
});

test('highlights jsx/tsx aliases and keeps one rendered line per source line', () => {
  const source = [
    'import { useState } from "react";',
    '',
    'export function Demo() {',
    '  const [open, setOpen] = useState(false);',
    '  return <button onClick={() => setOpen(true)}>{open ? "on" : "off"}</button>;',
    '}',
  ].join('\n');

  const jsx = highlightSourceLines(source, 'jsx');
  assert.equal(jsx.language, 'javascript');
  assert.equal(jsx.lines.length, 6);
  assert.match(jsx.lines[0] ?? '', /hljs-keyword/);
  assert.match(jsx.lines[0] ?? '', /hljs-string/);

  const tsx = highlightSourceLines(source, 'tsx');
  assert.equal(tsx.language, 'typescript');
  assert.equal(tsx.lines.length, 6);
  assert.match(tsx.lines[0] ?? '', /hljs-keyword/);
});

test('falls back to plain text for unknown languages and oversized files', () => {
  const unknown = highlightSourceLines('const a = 1;', null);
  assert.equal(unknown.language, null);
  assert.deepEqual(unknown.lines, ['const a = 1;']);

  const oversized = 'x'.repeat(MAX_SOURCE_HIGHLIGHT_CHARS + 1);
  assert.ok(oversized.length > MAX_SOURCE_HIGHLIGHT_CHARS);
  const skipped = highlightSourceLines(oversized, 'javascript');
  assert.equal(skipped.language, null);
  assert.equal(skipped.lines.length, oversized.split('\n').length);
  assert.equal(highlightCode(oversized, 'javascript').html, null);
});
