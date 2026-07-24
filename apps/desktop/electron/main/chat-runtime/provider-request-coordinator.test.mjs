import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coordinateDesktopProviderRequest } from './provider-request-coordinator.mjs';

describe('Desktop provider request coordinator', () => {
  it('returns the request_preflight projection from the same messages used for sending', async () => {
    const result = await coordinateDesktopProviderRequest({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      systemPrompt: 'system',
      contextWindow: 10_000,
      providerConfig: {},
      tools: [{ type: 'function', function: { name: 'read_file', description: 'read' } }],
    });

    assert.equal(result.compacted, false);
    assert.equal(result.projection.projection.phase, 'request_preflight');
    assert.equal(
      result.projection.projection.nextRequestInputTokens,
      result.contextInfo.nextRequestInputTokens,
    );
    assert.deepEqual(result.projectedMessages, result.messages);
  });

  it('applies the shared microcompaction before projecting the provider request', async () => {
    const result = await coordinateDesktopProviderRequest({
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'working' },
        { role: 'assistant', content: 'done' },
      ],
      systemPrompt: 'system',
      contextWindow: 100_000,
      providerConfig: {},
    });

    assert.equal(result.compacted, false);
    assert.ok(result.projection.revision > 0);
    assert.equal(result.projection.projection.quality, 'projected');
    assert.equal(result.projection.projection.reason, 'request_preflight');
  });
});
