import assert from 'node:assert/strict';
import test from 'node:test';
import { applyThinkingEvent, createThinkingProcess } from './thinking-reducer.ts';

test('applyThinkingEvent content_delta concatenates thinking deltas with plain string join', () => {
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

  // Plain concat: if provider glues status phrases, they stay glued.
  assert.equal(
    process.iterations[0]?.thinkingContent,
    'Planning codebase inspectionInvestigating file path support issueInspecting code split',
  );
});

test('applyThinkingEvent content_delta concatenates mid-token deltas without spaces', () => {
  let process = createThinkingProcess({ maxIterations: 3 });
  process = applyThinkingEvent(process, 'react_start', { maxIterations: 3 })!;
  process = applyThinkingEvent(process, 'content_delta', { content: 'Plan' })!;
  process = applyThinkingEvent(process, 'content_delta', { content: 'ning' })!;
  process = applyThinkingEvent(process, 'content_delta', { content: ' inspection' })!;

  assert.equal(process.iterations[0]?.thinkingContent, 'Planning inspection');
});

test('applyThinkingEvent content_delta keeps camelCase identifier fragments intact', () => {
  let process = createThinkingProcess({ maxIterations: 3 });
  process = applyThinkingEvent(process, 'react_start', { maxIterations: 3 })!;
  for (const content of ['set', 'State', ' is', 'Thread', 'At', 'Bottom']) {
    process = applyThinkingEvent(process, 'content_delta', { content })!;
  }

  assert.equal(process.iterations[0]?.thinkingContent, 'setState isThreadAtBottom');
});
