import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldCliToolMessagesForDesktop } from './streamSegments.ts';

describe('foldCliToolMessagesForDesktop', () => {
  it('folds role=tool messages into previous assistant tool-call segments', () => {
    const folded = foldCliToolMessagesForDesktop([
      { id: 'u1', role: 'user', content: 'read it' },
      { id: 'a1', role: 'assistant', content: '' },
      {
        id: 't1',
        role: 'tool',
        content: 'file contents',
        tool: {
          capabilityId: 'local.file.read',
          toolName: 'Read',
          detail: 'file contents',
          status: 'completed',
          toolCallId: 'call-1',
          arguments: { path: 'package.json' },
        },
        segments: [{
          type: 'tool-call',
          tool: 'local.file.read',
          displayName: 'Read',
          args: { path: 'package.json' },
          result: 'file contents',
          toolCallId: 'call-1',
        }],
      },
      { id: 'a2', role: 'assistant', content: 'done' },
    ]);

    assert.equal(folded.length, 3);
    assert.equal(folded[1]?.role, 'assistant');
    const segments = folded[1]?.segments as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(segments));
    assert.equal(segments.length, 1);
    assert.equal(segments[0]?.type, 'tool-call');
    assert.equal(segments[0]?.tool, 'local.file.read');
    assert.equal(segments[0]?.toolCallId, 'call-1');
    assert.equal(segments[0]?.result, 'file contents');
  });
});
