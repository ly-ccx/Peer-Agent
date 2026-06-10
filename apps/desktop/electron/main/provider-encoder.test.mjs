import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  encodeAnthropicMessagesRequest,
  encodeOpenAIChatRequest,
  normalizeAnthropicMessages,
  normalizeOpenAIMessages,
} from './provider-encoders/index.mjs';

describe('Provider message encoders', () => {
  it('keeps OpenAI multimodal message parts in OpenAI shape', () => {
    const imageData = Buffer.from('image-bytes').toString('base64');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
      ],
    }];

    const encoded = normalizeOpenAIMessages(messages);

    assert.equal(encoded[0].content[0].type, 'text');
    assert.equal(encoded[0].content[1].type, 'image_url');
    assert.equal(encoded[0].content[1].image_url.url, `data:image/png;base64,${imageData}`);
  });

  it('lowers OpenAI-style image_url parts to Anthropic image blocks', () => {
    const imageData = Buffer.from('image-bytes').toString('base64');
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
      ],
    }];

    const encoded = normalizeAnthropicMessages(messages);

    assert.equal(encoded[0].content[0].type, 'text');
    assert.equal(encoded[0].content[1].type, 'image');
    assert.equal(encoded[0].content[1].source.type, 'base64');
    assert.equal(encoded[0].content[1].source.media_type, 'image/png');
    assert.equal(encoded[0].content[1].source.data, imageData);
  });

  it('does not turn non-image data URLs into Anthropic image blocks', () => {
    const textData = Buffer.from('hello').toString('base64');
    const messages = [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:text/plain;base64,${textData}` } },
      ],
    }];

    const encoded = normalizeAnthropicMessages(messages);

    assert.equal(encoded[0].content, '');
  });

  it('encodes OpenAI chat request shape in one provider boundary', () => {
    const body = encodeOpenAIChatRequest({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'bash' } }],
      effort: 'high',
    });

    assert.equal(body.model, 'gpt-test');
    assert.equal(body.stream, true);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.messages[0].content, 'hello');
    assert.equal(body.tools[0].function.name, 'bash');
  });

  it('encodes Anthropic messages request shape in one provider boundary', () => {
    const body = encodeAnthropicMessagesRequest({
      model: 'claude-test',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'bash' }],
      effort: 'high',
    });

    assert.equal(body.model, 'claude-test');
    assert.equal(body.system, 'system prompt');
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, 16384);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.tools[0].name, 'bash');
  });
});
