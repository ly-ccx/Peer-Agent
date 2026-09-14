import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAnthropicMessages } from './provider-encoders/message-normalizer.mjs';
import { encodeAnthropicMessagesRequest } from './provider-encoders/request-encoder.mjs';

test('normalizeAnthropicMessages retains thinking block with signature', () => {
  const input = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'Let me figure this out', signature: 'sig-abc123' },
      { type: 'text', text: 'Here is the answer.' },
      { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } },
    ],
  }];
  const out = normalizeAnthropicMessages(input);
  const blocks = out[0].content;
  assert.ok(Array.isArray(blocks), 'content should be array');
  const thinkingBlock = blocks.find((b) => b.type === 'thinking');
  assert.ok(thinkingBlock, 'thinking block should survive');
  assert.equal(thinkingBlock.thinking, 'Let me figure this out');
  assert.equal(thinkingBlock.signature, 'sig-abc123');
  assert.equal(blocks.length, 3, 'all 3 blocks should survive');
  assert.equal(blocks[0].type, 'thinking', 'thinking should be first');
  assert.equal(blocks[1].type, 'text', 'text should be second');
  assert.equal(blocks[2].type, 'tool_use', 'tool_use should be third');
});

test('normalizeAnthropicMessages retains thinking block without signature (silent thinking)', () => {
  const input = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Answer' },
    ],
  }];
  const out = normalizeAnthropicMessages(input);
  const blocks = out[0].content;
  assert.ok(blocks.find((b) => b.type === 'thinking'), 'empty thinking block should survive');
  assert.equal(blocks.length, 2);
});

test('normalizeAnthropicMessages still filters unknown block types', () => {
  const input = [{
    role: 'assistant',
    content: [
      { type: 'unknown_block_type', data: 'should not survive' },
      { type: 'text', text: 'Real answer' },
      { type: 'thinking', thinking: 'deep', signature: 'sig-x' },
    ],
  }];
  const out = normalizeAnthropicMessages(input);
  const blocks = out[0].content;
  assert.equal(blocks.length, 2, 'unknown block type should be filtered');
  assert.ok(!blocks.find((b) => b.type === 'unknown_block_type'), 'unknown type not present');
  assert.ok(blocks.find((b) => b.type === 'thinking'), 'thinking still survives');
});

test('normalizeAnthropicMessages retains tool_result, tool_use, image type blocks', () => {
  const input = [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'Using tool' },
      { type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: '/x' } },
      { type: 'tool_result', tool_use_id: 'tu1', content: 'content' },
    ],
  }];
  const out = normalizeAnthropicMessages(input);
  assert.equal(out[0].content.length, 3, 'tool_use + tool_result should survive');
  assert.ok(out[0].content.find((b) => b.type === 'tool_use'));
  assert.ok(out[0].content.find((b) => b.type === 'tool_result'));
});

// 回归守卫: 真实链路走 encodeAnthropicMessagesRequest -> normalizeAnthropicMessages。
// 修复前 thinking 块在这一步被静默丢弃, DeepSeek Anthropic 兼容端点在 thinking
// 模式下会返回 HTTP 400 "The `content[].thinking` in the thinking mode must be
// passed back to the API."。本用例锁定多轮工具调用的 assistant 历史形态。
test('encodeAnthropicMessagesRequest keeps thinking block in assistant history (multi-turn tool call)', () => {
  const body = encodeAnthropicMessagesRequest({
    model: 'deepseek-flash',
    system: 'You are helpful.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'check' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I need to think', signature: 'sig-1' },
          { type: 'text', text: 'ok' },
          { type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'ls' } },
        ],
      },
    ],
    tools: [],
    effort: 'max',
    supportsReasoning: true,
  });

  assert.equal(body.thinking?.type, 'enabled', 'thinking mode should stay enabled');
  const assistant = body.messages.filter((m) => m.role === 'assistant').pop();
  assert.ok(assistant, 'assistant message should be present');

  const thinkingBlocks = assistant.content.filter((b) => b.type === 'thinking');
  assert.equal(thinkingBlocks.length, 1, 'thinking block must be passed back');
  assert.equal(thinkingBlocks[0].thinking, 'I need to think');
  assert.equal(thinkingBlocks[0].signature, 'sig-1', 'signature must be preserved');

  assert.equal(assistant.content[0].type, 'thinking', 'thinking must stay first');
  assert.ok(assistant.content.find((b) => b.type === 'tool_use'), 'tool_use must survive');
});