import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveChannel } from './provider-channels.mjs';
import { encodeAnthropicMessagesRequest, encodeOpenAIChatRequest } from './provider-encoders/request-encoder.mjs';
import { encodeOpenAIResponsesRequest } from './provider-encoders/responses-encoder.mjs';

const legacy = {
  supportsReasoning: true,
  reasoningParamStyle: 'openai-effort',
  reasoningEffortLevels: ['off', 'low', 'default', 'high', 'xhigh'],
  reasoningEffortMap: { off: 'off', low: 'low', default: 'medium', high: 'high', xhigh: 'xhigh' },
};

const chatBody = (model, effort, extra = {}) => {
  const resolved = resolveChannel({ channelId: 'opencode-go', model, ...extra });
  return encodeOpenAIChatRequest({ ...resolved, model, messages: [], tools: [], effort });
};

// 声明有无 × 合法/非法档位 × 新配置/旧五档。
for (const oldConfig of [false, true]) {
  for (const [model, declared, high, extreme] of [
    ['glm-5.3-flash', true, 'high', 'max'],
    ['mimo-v2.6-flash', false, undefined, undefined],
  ]) {
    for (const effort of ['high', 'xhigh']) {
      test(`Go ${model} ${effort} legacy=${oldConfig}`, () => {
        const body = chatBody(model, effort, oldConfig ? legacy : {});
        const expected = !declared ? undefined : (effort === 'high' ? high : extreme);
        assert.equal(body.reasoning_effort, expected);
      });
    }
  }
}

test('undeclared Go models omit every global effort', () => {
  for (const model of ['mimo-v2.6-flash', 'qwen3.7-max', 'future-model']) {
    for (const effort of ['off', 'low', 'default', 'high', 'xhigh', 'max']) {
      assert.equal(Object.hasOwn(chatBody(model, effort, legacy), 'reasoning_effort'), false, `${model}:${effort}`);
    }
  }
});

test('declared Go chat models map only their own values', () => {
  assert.equal(chatBody('deepseek-v4-pro', 'default', legacy).reasoning_effort, 'high');
  assert.equal(chatBody('qwen3.8-max', 'xhigh', legacy).reasoning_effort, 'xhigh');
  assert.equal(chatBody('qwen3.8-max', 'high', legacy).reasoning_effort, 'xhigh');
  assert.equal(Object.hasOwn(chatBody('kimi-k3', 'low', legacy), 'reasoning_effort'), false);
  assert.equal(chatBody('kimi-k3', 'max', legacy).reasoning_effort, 'max');
});

test('Luna uses its declared Responses effort and ignores stale xhigh-only maps', () => {
  const resolved = resolveChannel({ channelId: 'opencode-go', model: 'gpt-5.6-luna', ...legacy });
  const body = encodeOpenAIResponsesRequest({
    ...resolved, model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }], effort: 'off',
  });
  assert.equal(body.reasoning.effort, 'none');
});

test('Claude on Go stays a toggle when only budgetless thinking is declared', () => {
  const resolved = resolveChannel({ channelId: 'opencode-go', model: 'claude-sonnet-4-6', ...legacy });
  const body = encodeAnthropicMessagesRequest({
    ...resolved, model: 'claude-sonnet-4-6', messages: [], effort: 'xhigh',
  });
  assert.equal(body.thinking, undefined);
  assert.equal(body.output_config, undefined);
});

test('explicit maps stay closed and native OpenAI keeps xhigh', () => {
  assert.equal(encodeOpenAIChatRequest({ model: 'test', messages: [], supportsReasoning: true,
    reasoningEffortMap: { off: 'none', high: 'high' }, effort: 'xhigh' }).reasoning_effort, undefined);
  assert.equal(encodeOpenAIChatRequest({ model: 'test', messages: [], supportsReasoning: true,
    effort: 'xhigh' }).reasoning_effort, 'xhigh');
});
