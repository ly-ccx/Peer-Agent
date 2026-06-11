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
    // ADR 24 prompt caching: system 由字符串降为带 ephemeral cache_control 的 text block 数组。
    assert.ok(Array.isArray(body.system));
    assert.equal(body.system[0].type, 'text');
    assert.equal(body.system[0].text, 'system prompt');
    assert.equal(body.system[0].cache_control.type, 'ephemeral');
    assert.equal(body.stream, true);
    assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.thinking.budget_tokens, 32768);
    // 回归保护: 开启 thinking 时 max_tokens 必须严格大于 budget_tokens，
    // 否则 Anthropic API 返回 400，"深度"模式必挂。
    assert.equal(body.max_tokens, 32768 + 16384);
    assert.ok(body.max_tokens > body.thinking.budget_tokens);
    assert.equal(body.tools[0].name, 'bash');
  });

  it('does not enable Anthropic thinking for default effort', () => {
    const body = encodeAnthropicMessagesRequest({
      model: 'claude-test',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'bash' }],
      effort: 'default',
    });

    assert.equal(body.thinking, undefined);
    assert.equal(body.max_tokens, 16384);
  });

  it('applies ephemeral cache_control to system and the second-to-last message (ADR 24)', () => {
    const body = encodeAnthropicMessagesRequest({
      model: 'claude-test',
      system: 'stable system prefix',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'latest question' },
      ],
      effort: 'default',
    });

    // system 断点: 字符串降为带 ephemeral 的 text block 数组。
    assert.ok(Array.isArray(body.system));
    assert.equal(body.system[0].cache_control.type, 'ephemeral');

    // 历史前缀断点: 打在【倒数第二条】(稳定前缀边界), 即 assistant 'reply'。
    const secondToLast = body.messages[body.messages.length - 2];
    assert.ok(Array.isArray(secondToLast.content));
    const markedBlock = secondToLast.content[secondToLast.content.length - 1];
    assert.equal(markedBlock.cache_control.type, 'ephemeral');

    // 最后一条 (本轮新输入) 不应带断点 —— 否则每轮断点位置都变, 永远命中不到旧缓存。
    const lastMsg = body.messages[body.messages.length - 1];
    const lastBlocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
    for (const block of lastBlocks) {
      assert.equal(block.cache_control, undefined);
    }

    // 第一条也不应带断点。
    const firstMsg = body.messages[0];
    const firstBlocks = Array.isArray(firstMsg.content) ? firstMsg.content : [];
    for (const block of firstBlocks) {
      assert.equal(block.cache_control, undefined);
    }
  });

  it('skips history breakpoint when only one message exists (ADR 24)', () => {
    const body = encodeAnthropicMessagesRequest({
      model: 'claude-test',
      system: 'stable system prefix',
      messages: [{ role: 'user', content: 'only message' }],
      effort: 'default',
    });

    // system 仍打断点。
    assert.ok(Array.isArray(body.system));
    assert.equal(body.system[0].cache_control.type, 'ephemeral');

    // 单条消息(首轮)无稳定历史前缀, 该消息不应被打断点。
    const onlyMsg = body.messages[0];
    const blocks = Array.isArray(onlyMsg.content) ? onlyMsg.content : [];
    for (const block of blocks) {
      assert.equal(block.cache_control, undefined);
    }
  });
});
