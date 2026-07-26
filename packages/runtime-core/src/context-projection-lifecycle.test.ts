import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContextProjectionLifecycle } from './context-projection-lifecycle.ts';

describe('context projection lifecycle', () => {
  it('publishes ordered request, stream, tool, compaction, and completion phases', () => {
    const published: string[] = [];
    const lifecycle = createContextProjectionLifecycle(({ projection }) => {
      published.push(projection.phase);
    });
    const base = {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'read_file', description: 'read one file' }],
      contextWindow: 10_000,
      now: 1,
    };

    const preflight = lifecycle.requestPreflight(base);
    const preview = lifecycle.streamPreview('assistant output', { now: 2 });
    const tool = lifecycle.toolResult({ ...base, messages: [...base.messages, { role: 'assistant', content: 'assistant output' }, { role: 'tool', content: 'result' }], now: 3 });
    const compacted = lifecycle.postCompaction({ ...base, messages: [{ role: 'system', content: 'summary' }], now: 4 });
    const completed = lifecycle.turnComplete({ ...base, messages: [{ role: 'system', content: 'summary' }, { role: 'assistant', content: 'done' }], now: 5 });

    assert.deepEqual(published, ['request_preflight', 'stream_preview', 'tool_result', 'post_compaction', 'turn_complete']);
    assert.equal(preflight.projection.quality, 'projected');
    assert.equal(preview.projection.quality, 'preview');
    assert.ok(preview.projection.previewInputTokens! > preflight.projection.nextRequestInputTokens!);
    assert.equal(tool.revision, 3);
    assert.ok(compacted.projection.nextRequestInputTokens! < tool.projection.nextRequestInputTokens!);
    assert.equal(completed.projection.phase, 'turn_complete');
  });

  it('replaces provisional stream growth at the next stable boundary', () => {
    const lifecycle = createContextProjectionLifecycle();
    const input = { messages: [{ role: 'user', content: 'x' }], contextWindow: 1_000 };
    const base = lifecycle.requestPreflight(input);
    const first = lifecycle.streamPreview('a'.repeat(400));
    const second = lifecycle.streamPreview('b'.repeat(400));
    const complete = lifecycle.turnComplete(input);

    assert.ok(second.projection.previewInputTokens! > first.projection.previewInputTokens!);
    assert.equal(complete.projection.nextRequestInputTokens, base.projection.nextRequestInputTokens);
    assert.equal(complete.projection.previewInputTokens, null);
  });

  it('publishes restored state without inventing a percentage for an unknown window', () => {
    const lifecycle = createContextProjectionLifecycle();
    const restored = lifecycle.restored({ messages: [{ role: 'user', content: 'restored' }] });
    assert.equal(restored.projection.phase, 'restored');
    assert.equal(restored.projection.percent, null);
    assert.equal(restored.projection.pressure, 'unknown');
  });
});
