import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactJson } from './records.ts';

describe('compactJson', () => {
  it('returns valid JSON when compacting oversized objects', () => {
    const result = compactJson({
      kind: 'local_tool_result_ref',
      outputPreview: {
        stdoutPreview: 'x'.repeat(6000),
      },
    });

    const parsed = JSON.parse(result);
    assert.equal(parsed.truncated, true);
    assert.equal(typeof parsed.originalChars, 'number');
    assert.match(parsed.preview, /local_tool_result_ref/);
  });
});
