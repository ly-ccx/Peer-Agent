import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GOAL_KEEP_POLICY,
  resolveGoalKeepBudget,
  selectGoalKeepMessages,
  skeletonizeKeepToolResults,
} from './goal-keep-policy.ts';

test('resolveGoalKeepBudget clamps to window ratio and hard max', () => {
  const budget = resolveGoalKeepBudget(258_000);
  // 10% of 258k would be 25800, but hard maxKeepTokens is 16384.
  assert.equal(
    budget.keepBudgetTokens,
    Math.min(
      GOAL_KEEP_POLICY.maxKeepTokens,
      Math.max(
        GOAL_KEEP_POLICY.minKeepTokens,
        Math.floor(258_000 * GOAL_KEEP_POLICY.keepContextRatio),
      ),
    ),
  );
  assert.equal(budget.keepBudgetTokens, GOAL_KEEP_POLICY.maxKeepTokens);
  assert.ok(budget.targetRequestTokens !== null);
  assert.ok((budget.softTriggerTokens ?? 0) > (budget.targetRequestTokens ?? 0));
});

test('selectGoalKeepMessages bounds oversized current-turn tool tails', () => {
  const huge = `tool-output-${'x'.repeat(40_000)}`;
  const messages = [
    { role: 'user', content: `old task ${'a'.repeat(2_000)}` },
    { role: 'assistant', content: `old answer ${'b'.repeat(2_000)}` },
    { role: 'user', content: 'current task please inspect' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-keep-huge',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"ls"}' },
        },
        {
          id: 'call-keep-open',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"pwd"}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call-keep-huge',
      content: huge,
    },
  ];

  const selected = selectGoalKeepMessages(messages, {
    contextWindow: 32_000,
    recoveryLevel: 0,
  });

  assert.ok(selected.keepMessages.length > 0);
  assert.ok(selected.keepTokens <= selected.keepBudgetTokens);
  assert.ok(selected.keepMessages.some((message) => message.role === 'user'));
  // Old history should be available for summarization.
  assert.ok(selected.oldMessages.length > 0);
});

test('skeletonizeKeepToolResults shrinks latest-turn tool payloads', () => {
  const huge = 'y'.repeat(12_000);
  const keep = [
    { role: 'user', content: 'current' },
    { role: 'tool', tool_call_id: 't1', content: huge },
  ];
  const result = skeletonizeKeepToolResults(keep, {
    headChars: 400,
    tailChars: 100,
    triggerChars: 800,
  });
  assert.equal(result.changed, true);
  assert.equal(typeof result.messages[1]?.content, 'string');
  assert.ok(String(result.messages[1]?.content).length < huge.length);
});

test('recoveryLevel 5 shrinks to human anchor plus tool skeleton', () => {
  const huge = `tool-output-${'z'.repeat(20_000)}`;
  const messages = [
    { role: 'user', content: 'start goal' },
    { role: 'assistant', content: 'working' },
    { role: 'user', content: 'continue with current task' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'bash', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: huge },
  ];

  const selected = selectGoalKeepMessages(messages, {
    contextWindow: 32_000,
    recoveryLevel: 5,
  });

  assert.equal(selected.recoveryLevel, 5);
  assert.equal(selected.degraded, true);
  assert.match(selected.reason, /anchor_plus_open_tool_skeleton|tool_results|microcompact|trimmed/);
  assert.ok(selected.keepTokens <= selected.keepBudgetTokens);
  const tool = selected.keepMessages.find((message) => message.role === 'tool');
  if (tool) {
    assert.ok(String(tool.content ?? '').length < huge.length);
  }
});
