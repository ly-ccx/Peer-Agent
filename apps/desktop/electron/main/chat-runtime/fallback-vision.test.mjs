import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  extractImageUrlsFromMessage,
  processTrailingUserImages,
  readFallbackVisionProviderId,
  recognizeImagesWithFallbackProvider,
  stripImagePartsFromMessage,
} from './fallback-vision.mjs';

const SAMPLE_URL = 'data:image/png;base64,abc';

describe('fallback-vision message transforms', () => {
  it('strips image_url parts and keeps text', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: SAMPLE_URL } },
      ],
    };
    const { message: next, strippedCount } = stripImagePartsFromMessage(message);
    assert.equal(strippedCount, 1);
    // 仅剩单段 text 时折叠为纯字符串，便于非 vision 模型消费。
    assert.equal(next.content, 'look');
  });

  it('only processes trailing user messages (new images)', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'old' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,old' } },
        ],
      },
      { role: 'assistant', content: 'ok' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'new' },
          { type: 'image_url', image_url: { url: SAMPLE_URL } },
        ],
      },
    ];
    const result = processTrailingUserImages(messages, { supportsVision: false });
    assert.equal(result.changed, true);
    assert.equal(result.imageUrls.length, 1);
    assert.equal(result.imageUrls[0], SAMPLE_URL);
    assert.equal(extractImageUrlsFromMessage(result.messages[0]).length, 1);
    assert.equal(extractImageUrlsFromMessage(result.messages[2]).length, 0);
    assert.match(JSON.stringify(result.messages[2].content), /image omitted|new/i);
  });

  it('silently injects recognition text when descriptions are provided', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'fix this UI' },
          { type: 'image_url', image_url: { url: SAMPLE_URL } },
        ],
      },
    ];
    const result = processTrailingUserImages(messages, {
      supportsVision: false,
      imageDescriptions: ['A settings dialog with a Save button.'],
    });
    assert.equal(result.changed, true);
    assert.equal(result.recognizedImageCount, 1);
    const content = result.messages[0].content;
    const text = Array.isArray(content)
      ? content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      : String(content);
    assert.match(text, /Image recognition/);
    assert.match(text, /settings dialog/i);
    assert.equal(extractImageUrlsFromMessage(result.messages[0]).length, 0);
  });

  it('does nothing when the main model supports vision', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: SAMPLE_URL } }],
      },
    ];
    const result = processTrailingUserImages(messages, { supportsVision: true });
    assert.equal(result.changed, false);
    assert.equal(result.messages, messages);
  });

  it('reads fallbackVision providerId from settings shapes', () => {
    assert.equal(readFallbackVisionProviderId({ fallbackVision: 'abc' }), 'abc');
    assert.equal(
      readFallbackVisionProviderId({ fallbackVision: { providerId: 'p1::m1' } }),
      'p1::m1',
    );
    assert.equal(readFallbackVisionProviderId({}), null);
    assert.equal(readFallbackVisionProviderId(null), null);
  });

  it('uses the provider Responses wire for OAuth vision and encodes input_image', async () => {
    let credentialCalls = 0;
    let request = null;
    const result = await recognizeImagesWithFallbackProvider({
      provider: {
        id: 'grok-oauth',
        model: 'grok-4.5',
        authMethod: 'oauth_grok',
        supportsVision: true,
      },
      imageUrls: [SAMPLE_URL],
      userText: 'What is shown?',
      getCredential: async () => {
        credentialCalls += 1;
        return { accessToken: 'test-token' };
      },
      resolveChannel: (provider) => ({
        wire: 'openai-responses',
        endpoint: 'https://example.test/v1/responses',
        headers: { authorization: `Bearer ${provider.accessToken}` },
      }),
      fetchImpl: async (url, init) => {
        request = { url, body: JSON.parse(init.body) };
        return {
          ok: true,
          json: async () => ({ output_text: 'A refresh icon appears in the upper-right corner.' }),
        };
      },
    });

    assert.equal(credentialCalls, 1);
    assert.equal(request.url, 'https://example.test/v1/responses');
    assert.equal(request.body.stream, false);
    assert.ok(Array.isArray(request.body.input));
    const imagePart = request.body.input
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .find((part) => part.type === 'input_image');
    assert.deepEqual(imagePart, { type: 'input_image', image_url: SAMPLE_URL });
    assert.equal(result.ok, true);
    assert.equal(result.wire, 'openai-responses');
    assert.deepEqual(result.descriptions, ['A refresh icon appears in the upper-right corner.']);
  });

  it('requires the caller to inject the governed network transport', async () => {
    let credentialCalls = 0;
    const result = await recognizeImagesWithFallbackProvider({
      provider: { id: 'oauth', model: 'vision', authMethod: 'oauth_grok' },
      imageUrls: [SAMPLE_URL],
      getCredential: async () => {
        credentialCalls += 1;
        return { accessToken: 'test-token' };
      },
      resolveChannel: () => ({
        wire: 'openai-responses',
        endpoint: 'https://example.test/v1/responses',
        headers: {},
      }),
    });

    assert.deepEqual(result, {
      ok: false,
      error: 'fetch_unavailable',
      descriptions: [],
    });
    assert.equal(credentialCalls, 0);
  });

  it('does not rewrite a Responses endpoint to chat completions on failure', async () => {
    let requestedUrl = null;
    const result = await recognizeImagesWithFallbackProvider({
      provider: { id: 'oauth', model: 'vision', authMethod: 'oauth_grok' },
      imageUrls: [SAMPLE_URL],
      getCredential: async () => ({ accessToken: 'test-token' }),
      resolveChannel: () => ({
        wire: 'openai-responses',
        endpoint: 'https://example.test/v1/responses',
        headers: {},
      }),
      fetchImpl: async (url) => {
        requestedUrl = url;
        return { ok: false, status: 401, text: async () => 'sensitive body' };
      },
    });

    assert.equal(requestedUrl, 'https://example.test/v1/responses');
    assert.deepEqual(result, {
      ok: false,
      error: 'openai_responses_http_401',
      descriptions: [],
    });
  });
});
