import assert from 'node:assert/strict';
import test from 'node:test';

import { highlightCode } from '../../chat/components/markdown/codeHighlighter.ts';
import { highlightSourceLines, splitHighlightedHtmlByLine } from './sourceHighlight.ts';

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

  const oversized = `${'const a = 1;\n'.repeat(2_000)}// tail`;
  assert.ok(oversized.length > 20_000);
  const skipped = highlightSourceLines(oversized, 'javascript');
  assert.equal(skipped.language, null);
  assert.equal(skipped.lines.length, oversized.split('\n').length);
  assert.equal(highlightCode(oversized, 'javascript').html, null);
});
