import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const source = readFileSync(
  new URL('./AssistantContent.tsx', import.meta.url),
  'utf8',
);

describe('CompactionSummaryCard', () => {
  it('shows the exact compaction strategy names', () => {
    assert.match(source, /LLM summary/);
    assert.match(source, /Structured fallback/);
    assert.match(source, /Fallback drop/);
  });

  it('warns visibly when fallback_drop discarded older context', () => {
    assert.match(source, /compaction\.method === 'fallback_drop'/);
    assert.match(source, /较早细节可能丢失/);
    assert.match(source, /role="alert"/);
  });
});
