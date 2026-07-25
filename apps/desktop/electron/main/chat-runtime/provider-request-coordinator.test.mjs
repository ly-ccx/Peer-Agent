import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coordinateDesktopProviderRequest,
  executeDesktopProviderRequest,
} from './provider-request-coordinator.mjs';

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

  it('uses provider-observed 498K input as compaction authority before sending', async () => {
    let compactCalls = 0;
    let sendCalls = 0;
    const result = await executeDesktopProviderRequest({
      request: {
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'short visible history' },
        ],
        systemPrompt: 'system',
        contextWindow: 500_000,
        providerConfig: { model: 'grok-4.5' },
        usageSnapshot: { inputTokens: 498_138 },
      },
      compactRequest: async ({ messages, systemPrompt }) => {
        compactCalls += 1;
        return {
          compacted: true,
          messages: messages.slice(-1),
          systemPrompt,
        };
      },
      send: async () => {
        sendCalls += 1;
        return {
          ok: true,
          streamUsage: { inputTokens: 12_000 },
        };
      },
    });

    assert.equal(compactCalls, 1);
    assert.equal(sendCalls, 1);
    assert.equal(result.compacted, true);
    assert.equal(result.snapshot.authoritativeInputTokens, 12_000);
  });

  it('compacts and retries once when Grok returns maximum prompt length evidence', async () => {
    let compactCalls = 0;
    let sendCalls = 0;
    const result = await executeDesktopProviderRequest({
      request: {
        messages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: 'history' },
          { role: 'user', content: 'latest' },
        ],
        systemPrompt: '',
        contextWindow: 500_000,
        providerConfig: { model: 'grok-4.5' },
      },
      compactRequest: async ({ messages, systemPrompt }) => {
        compactCalls += 1;
        return {
          compacted: true,
          messages: messages.slice(-1),
          systemPrompt,
        };
      },
      send: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          return {
            ok: false,
            status: 400,
            errorText:
              "This model's maximum prompt length is 500000 but the request contains 501244 tokens.",
          };
        }
        return { ok: true, streamUsage: { inputTokens: 2_000 } };
      },
    });

    assert.equal(compactCalls, 1);
    assert.equal(sendCalls, 2);
    assert.equal(result.retriedAfterOverflow, true);
    assert.equal(result.snapshot.lastOverflow.requestedTokens, 501_244);
    assert.equal(result.snapshot.lastOverflow.maximumTokens, 500_000);
  });
});
