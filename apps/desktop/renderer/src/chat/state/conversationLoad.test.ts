import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  foldCliToolMessagesForDesktop,
  normalizeToolCallResultForDesktop,
} from './streamSegments.ts';

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

  it('folds consecutive Rust worker assistant rows sharing one streamId into one turn and normalizes object results', () => {
    const folded = foldCliToolMessagesForDesktop([
      { id: 'u1', role: 'user', content: 'Delegated Task: Research ACP' },
      {
        id: 'a1',
        role: 'assistant',
        streamId: 'stream-worker-1',
        content: 'Starting research.',
        createdAt: '2026-11-25T12:00:41.205Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        streamId: 'stream-worker-1',
        content: '',
        segments: [{
          type: 'tool-call',
          tool: 'bash',
          toolCallId: 'call-bash',
          args: { command: 'ls' },
          result: {
            status: 'denied',
            error: { code: 'tool_not_projected', message: 'Tool bash is not projected' },
          },
        }],
      },
      {
        id: 'a3',
        role: 'assistant',
        streamId: 'stream-worker-1',
        content: '',
        segments: [{
          type: 'tool-call',
          tool: 'batch_search',
          toolCallId: 'call-batch',
          args: { queries: [{ id: 'q1', query: 'acp' }] },
          result: {
            status: 'success',
            output: {
              status: 'success',
              lanes: [{ laneId: 'q1', phase: 'completed', resultCount: 2 }],
              aggregate: { totalUniqueMatches: 2, truncated: false, matches: [] },
            },
          },
        }],
      },
      {
        id: 'a4',
        role: 'assistant',
        streamId: 'stream-worker-1',
        content: 'Final ACP comparison report.',
        segments: [
          { type: 'thinking', content: 'Synthesizing evidence' },
          { type: 'text', content: 'Final ACP comparison report.' },
        ],
      },
      // Separate streamId must NOT merge into the previous stream.
      {
        id: 'a5',
        role: 'assistant',
        streamId: 'stream-worker-2',
        content: 'Follow-up stream.',
      },
    ]);

    assert.equal(folded.length, 3);
    assert.equal(folded[0]?.id, 'u1');
    assert.equal(folded[1]?.id, 'a1');
    assert.equal(folded[1]?.content, 'Final ACP comparison report.');
    const segs = folded[1]?.segments as Array<Record<string, unknown>>;
    assert.deepEqual(
      segs.map((s) => s.type),
      ['text', 'tool-call', 'tool-call', 'thinking', 'text'],
    );
    assert.equal(segs[1]?.result, '[tool_not_projected] Tool bash is not projected');
    assert.equal(typeof segs[2]?.result, 'string');
    const parsedBatch = JSON.parse(segs[2]?.result as string);
    assert.equal(parsedBatch.lanes[0].laneId, 'q1');
    assert.equal(folded[2]?.id, 'a5');
  });

  it('keeps undefined tool results as undefined and extracts text previews safely', () => {
    assert.equal(normalizeToolCallResultForDesktop(undefined), undefined);
    assert.equal(normalizeToolCallResultForDesktop(null), undefined);
    assert.equal(
      normalizeToolCallResultForDesktop({ output: { kind: 'text', preview: 'hello preview' } }),
      'hello preview',
    );
  });
});
