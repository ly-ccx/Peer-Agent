import test from 'node:test';
import assert from 'node:assert/strict';
import { sendGeminiStream } from './gemini-adapter.mjs';

for (const [usageMetadata, expected] of [
  [{ promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 23 },
    { inputTokens: 15, outputTokens: 3, cacheReadTokens: 5 }],
  [{ promptTokenCount: 20, cachedContentTokenCount: 5, candidatesTokenCount: 3, thoughtsTokenCount: 7,
    toolUsePromptTokenCount: 2, totalTokenCount: 32 }, { inputTokens: 17, outputTokens: 10, cacheReadTokens: 5 }],
  [{ promptTokenCount: 20, candidatesTokenCount: 3, totalTokenCount: 23 },
    { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0 }],
]) test(`Gemini disjoint usage at the real stream adapter: ${usageMetadata.totalTokenCount}`, async () => {
  const result = await sendGeminiStream({
    baseUrl: 'https://fixture.invalid', model: 'fixture', messages: [],
    streamId: 'synthetic-cache-accounting', tracePrivacy: 'off',
    fetchImpl: async () => new Response(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'complete' }] }, finishReason: 'STOP' }],
      usageMetadata,
    })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.streamUsage, expected);
  assert.equal(Object.values(result.streamUsage).reduce((a, b) => a + b, 0), usageMetadata.totalTokenCount);
  assert.equal(Object.hasOwn(result.streamUsage, 'cacheWriteTokens'), false);
});
