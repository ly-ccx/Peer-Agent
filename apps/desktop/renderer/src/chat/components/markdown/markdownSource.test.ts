import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMarkdownSource, sourceLineStarts } from './markdownSource.ts';
import { parseMarkdownBlocks, markdownBlockSources } from './markdownParser.ts';

test('normalization retains UTF-16 offsets across CRLF and comments', () => {
  const source = '😀a\r\nb<!-- hidden -->c';
  const mapped = normalizeMarkdownSource(source);
  assert.equal(mapped.text, '😀a\nbc');
  assert.deepEqual(sourceLineStarts(mapped.text), [0, 4]);
  assert.equal(source[mapped.offsets[4]], 'b');
  assert.equal(source[mapped.offsets[5]], 'c');
  assert.equal(mapped.offsets.at(-1), source.length);
});

test('repeated paragraph and heading content retain distinct source positions', () => {
  const source = '## same\n\n**same** text\n\n**same** text';
  const blocks = parseMarkdownBlocks(source);
  assert.equal(blocks.length, 3);
  assert.equal(markdownBlockSources.get(blocks[0])?.offsets[0], 3);
  for (const [index, start] of [[1, 9], [2, 24]]) {
    const mapped = markdownBlockSources.get(blocks[index]);
    assert.ok(mapped);
    assert.equal(mapped.offsets[0], start);
    assert.equal(source.slice(mapped.offsets[0], mapped.offsets.at(-1)), mapped.text);
  }
});
