import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mapSelectionMessageSources } from './selectionMessageSource.ts';

for (const segmented of [false, true]) {
  for (const bold of [false, true]) {
    for (const entry of ['quote', 'sidebar']) {
      test(`${segmented ? 'tool-segmented' : 'single'} / ${bold ? 'bold' : 'plain'} repeated text / ${entry}`, () => {
        const repeated = bold ? '**same 😀**' : 'same 😀';
        const prefix = `${repeated}\n\n`;
        const full = prefix + repeated;
        const groups = segmented
          ? [{ type: 'text', content: prefix }, { type: 'tool-call-group' }, { type: 'text', content: repeated }]
          : [{ type: 'text', content: full }];
        const target = groups.at(-1)!;
        const mapped = mapSelectionMessageSources(full, groups).get(target)!;
        assert.ok(mapped);
        const local = (segmented ? 0 : prefix.length) + (bold ? 2 : 0);
        const start = mapped.start + local;
        assert.equal(start, prefix.length + (bold ? 2 : 0));
        assert.equal(mapped.text.slice(start, start + 'same 😀'.length), 'same 😀');
        assert.equal(mapped.text, full);
        if (segmented) {
          const hash = (text: string) => createHash('sha256').update(text).digest('hex');
          assert.notEqual(hash(target.content!), hash(full), 'old local-source hash reproduces mismatch');
          assert.equal(hash(mapped.text), hash(full));
        }
      });
    }
  }
}

test('rejects all mappings on mismatched, reordered, partial or extra source', () => {
  for (const [source, groups] of [
    ['ab', [{ type: 'text', content: 'a' }]],
    ['ab', [{ type: 'text', content: 'b' }, { type: 'text', content: 'a' }]],
    ['ab', [{ type: 'text', content: 'a' }, { type: 'text', content: 'c' }]],
    ['a', [{ type: 'text', content: 'ab' }]],
  ] as const) assert.equal(mapSelectionMessageSources<{ type: string; content: string }>(source, groups).size, 0);
});

test('thinking is not a source text segment', () => {
  const groups = [{ type: 'thinking', content: 'private' }, { type: 'text', content: 'answer' }];
  const mapped = mapSelectionMessageSources('answer', groups);
  assert.equal(mapped.has(groups[0]), false);
  assert.deepEqual(mapped.get(groups[1]), { text: 'answer', start: 0 });
});
