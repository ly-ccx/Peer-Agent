import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectInstructionsPromptSource } from './project-instructions-source.mjs';

test('project instruction truncation preserves complete Unicode scalars and the actual included count', () => {
  const source = createProjectInstructionsPromptSource({ maxCharsPerFile: 4 });
  const observed = source.observe({ configInstructions: [{ id: 'unicode', content: 'aaa🙂tail' }] });
  assert.equal(observed.files[0].content, 'aaa');
  assert.equal(observed.files[0].includedChars, 3);
  assert.equal(observed.files[0].originalChars, 9);
  assert.equal(observed.files[0].truncated, true);
  assert.match(source.render(observed)[0].content, /included 3 of 9 chars/);
});
