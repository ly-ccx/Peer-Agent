import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contextAccountingModelKey,
  normalizeContextUsageBreakdown,
} from './context-accounting.ts';

test('context accounting model identity is canonical across Desktop and TUI bindings', () => {
  assert.equal(
    contextAccountingModelKey('provider-a', 'grok-4.5'),
    'provider-a::grok-4.5',
  );
  assert.equal(
    contextAccountingModelKey('provider-a::grok-4.5', 'grok-4.5'),
    'provider-a::grok-4.5',
  );
});

test('context usage breakdown keeps only positive known categories', () => {
  assert.equal(normalizeContextUsageBreakdown(null), null);
  assert.equal(normalizeContextUsageBreakdown({ version: 1, quality: 'scaled' }), null);
  assert.deepEqual(
    normalizeContextUsageBreakdown({
      version: 1,
      quality: 'scaled',
      estimatedTokens: 100,
      categories: [
        { id: 'conversation', tokens: 80 },
        { id: 'unknown_bucket', tokens: 10 },
        { id: 'system_prompt', tokens: 0 },
        { id: 'tool_definitions', tokens: 20.8 },
      ],
    }),
    {
      version: 1,
      quality: 'scaled',
      estimatedTokens: 100,
      categories: [
        { id: 'conversation', tokens: 80 },
        { id: 'tool_definitions', tokens: 20 },
      ],
    },
  );
});
