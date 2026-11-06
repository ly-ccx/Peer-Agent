import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedPresentation, presentationLimitLabel, SOURCE_BUDGET } from './presentationBudget.ts';

test('bounds huge blank-line files while retaining truthful total line counts', () => {
  const content = '\n'.repeat(50_000), shown = boundedPresentation(content);
  assert.equal(shown.shownLines, SOURCE_BUDGET.lines);
  assert.equal(shown.totalLines, 50_001);
  assert.equal(shown.text, content.slice(0, 3999));
  assert.equal(shown.truncated, true);
  assert.match(presentationLimitLabel(shown, false), /50001 total/);
});
test('character limits preserve UTF-16 pairs, accurate line counts, and the original value', () => {
  const content = 'a😀\nb', shown = boundedPresentation(content, { characters: 2, lines: 2 });
  assert.equal(shown.text, 'a'); assert.equal(shown.totalLines, 2); assert.equal(shown.maxLineLength, 3);
  assert.equal(content, 'a😀\nb');
  const exact = boundedPresentation('a\nb', { characters: 3, lines: 2 });
  assert.equal(exact.truncated, false); assert.equal(exact.shownLines, 2);
  assert.deepEqual(boundedPresentation('').text, ''); assert.equal(boundedPresentation('').totalLines, 0);
  assert.equal(boundedPresentation('x'.repeat(20), { characters: 5, lines: 2 }).shownCharacters, 5);
});
