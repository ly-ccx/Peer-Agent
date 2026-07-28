import assert from 'node:assert/strict';
import test from 'node:test';
import { joinThinkingContent } from './thinking-content-join.mjs';

test('joinThinkingContent keeps provider whitespace and mid-token streams intact', () => {
  assert.equal(joinThinkingContent('', 'Hello'), 'Hello');
  assert.equal(joinThinkingContent('Hello', ''), 'Hello');
  assert.equal(joinThinkingContent('Plan', 'ning'), 'Planning');
  assert.equal(joinThinkingContent('Hello ', 'world'), 'Hello world');
  assert.equal(joinThinkingContent('Hello\n', 'world'), 'Hello\nworld');
  assert.equal(joinThinkingContent('查看', '路径'), '查看路径');
});

test('joinThinkingContent inserts newline between glued GPT status phrases', () => {
  assert.equal(
    joinThinkingContent(
      'Reviewing architecture doc and session handling',
      'Planning to finalize and update existing plan',
    ),
    'Reviewing architecture doc and session handling\nPlanning to finalize and update existing plan',
  );
  assert.equal(
    joinThinkingContent('Inspecting file path support', 'Fixing earliest human turn tracking'),
    'Inspecting file path support\nFixing earliest human turn tracking',
  );
  assert.equal(
    joinThinkingContent('exploration', 'Investigating file path support issue'),
    'exploration\nInvestigating file path support issue',
  );
  assert.equal(joinThinkingContent('Done.', 'Next step'), 'Done.\nNext step');
});
