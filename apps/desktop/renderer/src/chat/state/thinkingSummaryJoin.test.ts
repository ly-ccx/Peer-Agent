import assert from 'node:assert/strict';
import test from 'node:test';
import { joinSummaryThinkingContent } from './thinkingSummaryJoin.ts';

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
  // User-facing glued summary phrases from the product screenshot shape
  assert.equal(
    joinSummaryThinkingContent('Clarifying active goal and intake phase', 'Planning authoritative goal retrieval'),
    'Clarifying active goal and intake phase\nPlanning authoritative goal retrieval',
  );
  assert.equal(
    joinSummaryThinkingContent(
      'Clarifying active goal and intake phase\nPlanning authoritative goal retrieval',
      'Preparing goal creation call',
    ),
    'Clarifying active goal and intake phase\nPlanning authoritative goal retrieval\nPreparing goal creation call',
  );
});

test('joinSummaryThinkingContent does not break camelCase identifier fragments', () => {
  assert.equal(joinSummaryThinkingContent('set', 'State'), 'setState');
  assert.equal(joinSummaryThinkingContent('is', 'Thread'), 'isThread');
  assert.equal(joinSummaryThinkingContent('Thread', 'At'), 'ThreadAt');
  assert.equal(joinSummaryThinkingContent('At', 'Bottom'), 'AtBottom');
  assert.equal(joinSummaryThinkingContent('Chat', 'Surface'), 'ChatSurface');

  let acc = '';
  for (const chunk of ['is', 'Thread', 'At', 'Bottom']) {
    acc = joinSummaryThinkingContent(acc, chunk);
  }
  assert.equal(acc, 'isThreadAtBottom');
});
