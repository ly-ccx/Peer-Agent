import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThinkingEvent, createThinkingProcess, joinThinkingContent } from './thinking-reducer.ts';

test('joinThinkingContent keeps provider whitespace and mid-token streams intact', () => {
  assert.equal(joinThinkingContent('', 'Hello'), 'Hello');
  assert.equal(joinThinkingContent('Hello', ''), 'Hello');
  assert.equal(joinThinkingContent('Plan', 'ning'), 'Planning');
  assert.equal(joinThinkingContent('hello ', 'world'), 'hello world');
  assert.equal(joinThinkingContent('hello', ' world'), 'hello world');
  assert.equal(joinThinkingContent('先确认', '登录态'), '先确认登录态');
});

test('joinThinkingContent inserts newline between glued English status phrases', () => {
  assert.equal(
    joinThinkingContent('Planning codebase inspection', 'Investigating file path'),
    'Planning codebase inspection\nInvestigating file path',
  );
  assert.equal(
    joinThinkingContent('logic', 'Fixing earliest human turn tracking'),
    'logic\nFixing earliest human turn tracking',
  );
  assert.equal(
    joinThinkingContent('exploration', 'Investigating file path support issue'),
    'exploration\nInvestigating file path support issue',
  );
  // sentence punctuation then capitalized phrase
  assert.equal(
    joinThinkingContent('Done.', 'Next step'),
    'Done.\nNext step',
  );
});

test('applyThinkingEvent content_delta joins glued reasoning status phrases with newlines', () => {
  let process = createThinkingProcess({ maxIterations: 3 });
  process = applyThinkingEvent(process, 'react_start', { maxIterations: 3 })!;
  process = applyThinkingEvent(process, 'iteration_start', {
    iteration: 1,
    message: '正在思考...',
  })!;
  process = applyThinkingEvent(process, 'content_delta', {
    content: 'Planning codebase inspection',
  })!;
  process = applyThinkingEvent(process, 'content_delta', {
    content: 'Investigating file path support issue',
  })!;
  process = applyThinkingEvent(process, 'content_delta', {
    content: 'Inspecting code split',
  })!;

  assert.equal(
    process.iterations[0]?.thinkingContent,
    [
      'Planning codebase inspection',
      'Investigating file path support issue',
      'Inspecting code split',
    ].join('\n'),
  );
});

test('applyThinkingEvent content_delta still concatenates mid-token deltas without spaces', () => {
  let process = createThinkingProcess({ maxIterations: 3 });
  process = applyThinkingEvent(process, 'react_start', { maxIterations: 3 })!;
  process = applyThinkingEvent(process, 'content_delta', { content: 'Plan' })!;
  process = applyThinkingEvent(process, 'content_delta', { content: 'ning' })!;
  process = applyThinkingEvent(process, 'content_delta', { content: ' inspection' })!;

  assert.equal(process.iterations[0]?.thinkingContent, 'Planning inspection');
});
