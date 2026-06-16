import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hydrateThinkingProcessFromBackend,
  iterationsFromBackendStepsData,
} from './historical-thinking-normalizer.ts';

test('iterationsFromBackendStepsData returns empty for null/missing input', () => {
  assert.deepEqual(iterationsFromBackendStepsData(null), []);
  assert.deepEqual(iterationsFromBackendStepsData(undefined), []);
  assert.deepEqual(iterationsFromBackendStepsData({}), []);
  assert.deepEqual(iterationsFromBackendStepsData({ steps: [] }), []);
});

test('iterationsFromBackendStepsData flattens steps + opens iteration per thinking node', () => {
  const out = iterationsFromBackendStepsData({
    steps: [
      {
        stepIndex: 1,
        iterations: [
          { iterationIndex: 1, type: 'thinking', content: '先看一下文件' },
          {
            iterationIndex: 2,
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'local_shell_exec',
            toolDisplayName: '本地 Bash 执行',
          },
          { iterationIndex: 3, type: 'observation', content: 'peer-agent local bash ok' },
        ],
      },
      {
        stepIndex: 2,
        iterations: [
          { iterationIndex: 4, type: 'thinking', content: '看起来是测试文件' },
        ],
      },
    ],
  });

  assert.equal(out.length, 2);
  assert.equal(out[0].thinkingContent, '先看一下文件');
  assert.equal(out[0].toolCards.length, 1);
  assert.equal(out[0].toolCards[0].toolCallId, 'tc-1');
  assert.equal(out[0].toolCards[0].displayName, '本地 Bash 执行');
  // observation 合并到上一个 toolCard 的 resultSummary
  assert.equal(out[0].toolCards[0].resultSummary, 'peer-agent local bash ok');
  assert.equal(out[1].thinkingContent, '看起来是测试文件');
  assert.equal(out[1].toolCards.length, 0);
});

test('iterationsFromBackendStepsData synthesizes a fallback iteration if first node is tool_call', () => {
  const out = iterationsFromBackendStepsData({
    steps: [
      {
        iterations: [
          {
            iterationIndex: 1,
            type: 'tool_call',
            toolCallId: 'tc-orphan',
            toolName: 'orphan_tool',
          },
        ],
      },
    ],
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].thinkingContent, '');
  assert.equal(out[0].toolCards.length, 1);
  assert.equal(out[0].toolCards[0].toolCallId, 'tc-orphan');
});

test('iterationsFromBackendStepsData handles silent thinking as empty content', () => {
  const out = iterationsFromBackendStepsData({
    steps: [
      {
        iterations: [
          { iterationIndex: 1, type: 'thinking', silent: true, content: '内部不展示' },
          { iterationIndex: 2, type: 'tool_call', toolCallId: 'tc-2', toolName: 'x' },
        ],
      },
    ],
  });

  assert.equal(out.length, 1);
  assert.equal(out[0].thinkingContent, '');
  assert.equal(out[0].toolCards.length, 1);
});

test('hydrateThinkingProcessFromBackend merges process metadata + iterations', () => {
  const hp = hydrateThinkingProcessFromBackend({
    process: {
      processUuid: 'p-1',
      executionUuid: 'e-1',
      status: 'completed',
      totalSteps: 2,
      totalToolCalls: 1,
      totalLlmCalls: 2,
      durationMs: 12345,
    },
    stepsData: {
      steps: [
        {
          iterations: [
            { iterationIndex: 1, type: 'thinking', content: 'first' },
            { iterationIndex: 2, type: 'tool_call', toolCallId: 'tc-1', toolName: 't' },
          ],
        },
        {
          iterations: [
            { iterationIndex: 3, type: 'thinking', content: 'second' },
          ],
        },
      ],
    },
  });

  assert.equal(hp.processUuid, 'p-1');
  assert.equal(hp.executionUuid, 'e-1');
  assert.equal(hp.status, 'completed');
  assert.equal(hp.toolCount, 1);
  assert.equal(hp.totalToolCalls, 1);
  assert.equal(hp.totalIterations, 2);
  assert.equal(hp.totalDurationMs, 12345);
  assert.equal(hp.maxIterations, 2);
  assert.equal(hp.iterations.length, 2);
  assert.equal(hp.iterations[0].thinkingContent, 'first');
  assert.equal(hp.iterations[1].thinkingContent, 'second');
  assert.equal(hp.expanded, true);
});

test('hydrateThinkingProcessFromBackend tolerates missing process + stepsData', () => {
  const hp = hydrateThinkingProcessFromBackend({});
  assert.equal(hp.iterations.length, 0);
  assert.equal(hp.status, 'completed');
  assert.equal(hp.maxIterations, 0);
  assert.equal(hp.toolCount, 0);
});

test('hydrateThinkingProcessFromBackend preserves backend running/error status', () => {
  const hp1 = hydrateThinkingProcessFromBackend({ process: { status: 'running' } });
  assert.equal(hp1.status, 'running');
  const hp2 = hydrateThinkingProcessFromBackend({ process: { status: 'error' } });
  assert.equal(hp2.status, 'error');
  const hp3 = hydrateThinkingProcessFromBackend({ process: { status: 'weirdly-unknown' } });
  assert.equal(hp3.status, 'completed');
});
