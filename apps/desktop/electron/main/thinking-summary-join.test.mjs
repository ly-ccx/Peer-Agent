import assert from 'node:assert/strict';
import test from 'node:test';
import { joinSummaryThinkingContent } from './thinking-summary-join.mjs';

test('joinSummaryThinkingContent keeps mid-token and spaced streams intact', () => {
  assert.equal(joinSummaryThinkingContent('', 'Hello'), 'Hello');
  assert.equal(joinSummaryThinkingContent('Hello', ''), 'Hello');
  assert.equal(joinSummaryThinkingContent('Plan', 'ning'), 'Planning');
  assert.equal(joinSummaryThinkingContent('hello ', 'world'), 'hello world');
  assert.equal(joinSummaryThinkingContent('hello', ' world'), 'hello world');
});

test('joinSummaryThinkingContent inserts newline between glued GPT status phrases', () => {
  assert.equal(
    joinSummaryThinkingContent('Planning inspection', 'Investigating path'),
    'Planning inspection\nInvestigating path',
  );
  assert.equal(
    joinSummaryThinkingContent('Inspecting file path support', 'Fixing earliest human turn tracking'),
    'Inspecting file path support\nFixing earliest human turn tracking',
  );
  assert.equal(
    joinSummaryThinkingContent('exploration', 'Investigating file path support issue'),
    'exploration\nInvestigating file path support issue',
  );
  assert.equal(joinSummaryThinkingContent('Done.', 'Next step'), 'Done.\nNext step');
  assert.equal(
    joinSummaryThinkingContent('Clarifying active goal and intake phase', 'Planning authoritative goal retrieval'),
    'Clarifying active goal and intake phase\nPlanning authoritative goal retrieval',
  );
});

test('joinSummaryThinkingContent does not break camelCase identifier fragments', () => {
  assert.equal(joinSummaryThinkingContent('set', 'State'), 'setState');
  assert.equal(joinSummaryThinkingContent('is', 'Thread'), 'isThread');
  assert.equal(joinSummaryThinkingContent('Thread', 'At'), 'ThreadAt');
  assert.equal(joinSummaryThinkingContent('Chat', 'Surface'), 'ChatSurface');

  let acc = '';
  for (const chunk of ['set', 'Thread', 'Scrolled']) {
    acc = joinSummaryThinkingContent(acc, chunk);
  }
  assert.equal(acc, 'setThreadScrolled');
});
