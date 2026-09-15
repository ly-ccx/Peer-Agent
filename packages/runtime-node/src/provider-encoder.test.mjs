import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeAnthropicMessagesRequest } from './provider-encoders/request-encoder.mjs';

// 回归背景（线上 400 复现）: GLM Coding Plan(国区) 走 anthropic-messages wire，
// 渠道声明的输出上限 maxOutputTokens = 131072（models.dev limit.output）。
// effort = xhigh 时 thinking.budget_tokens = 32768，编码器把 max_tokens 算成
// 32768 + 131072 = 163840，越过上游校验区间 [1, 131072]：
//   HTTP 400 {"code":"1210","message":"[1210][max_tokens参数非法：限制数值范围[1,131072]]"}
// 不变式: max_tokens 必须 ≤ 渠道输出上限，且严格大于 budget_tokens。
const GLM_OUTPUT_CEILING = 131072;

function encodeAnthropic({ effort, supportsReasoning = true, maxOutputTokens, reasoningParamStyle = 'anthropic-enabled-budget' }) {
  return encodeAnthropicMessagesRequest({
    model: 'glm-5.3',
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'bash' }],
    effort,
    supportsReasoning,
    reasoningParamStyle,
    maxOutputTokens,
  });
}

function assertWithinCeiling(body, ceiling) {
  assert.ok(
    body.max_tokens <= ceiling,
    `max_tokens ${body.max_tokens} 越过渠道输出上限 ${ceiling}`,
  );
  assert.ok(body.max_tokens > (body.thinking?.budget_tokens ?? 0), 'max_tokens 必须严格大于 budget_tokens');
}

test('keeps GLM max_tokens inside the channel output ceiling (400 code 1210 regression)', () => {
  const body = encodeAnthropic({ effort: 'xhigh', maxOutputTokens: GLM_OUTPUT_CEILING });

  // 复现前: 32768 + 131072 = 163840 → 上游 400。
  assert.notEqual(body.max_tokens, 32768 + GLM_OUTPUT_CEILING);
  assert.equal(body.max_tokens, GLM_OUTPUT_CEILING);
  // 思考预算没有被压缩: 天花板足够大, 回复预算吃到剩余空间。
  assert.equal(body.thinking.budget_tokens, 32768);
  assertWithinCeiling(body, GLM_OUTPUT_CEILING);
});

test('keeps every Anthropic effort tier inside the channel output ceiling', () => {
  for (const effort of ['off', 'low', 'default', 'high', 'xhigh']) {
    const body = encodeAnthropic({ effort, maxOutputTokens: GLM_OUTPUT_CEILING });
    assertWithinCeiling(body, GLM_OUTPUT_CEILING);
  }
});

test('shrinks the thinking budget when the ceiling is smaller than budget plus reply', () => {
  const body = encodeAnthropic({ effort: 'high', maxOutputTokens: 8192 });

  // 天花板 8192 < 32768 + 8192, 思考预算退让到半个窗口, 回复保留另一半。
  assert.equal(body.thinking.budget_tokens, 4096);
  assert.equal(body.max_tokens, 8192);
  assertWithinCeiling(body, 8192);
});

test('preserves the additive reply budget when the channel declares no output ceiling', () => {
  const body = encodeAnthropic({ effort: 'high' });

  assert.equal(body.thinking.budget_tokens, 32768);
  assert.equal(body.max_tokens, 32768 + 16384);
});

test('sends reply-only max_tokens when thinking is off', () => {
  const body = encodeAnthropic({ effort: 'off', maxOutputTokens: 8192 });

  assert.equal(body.thinking, undefined);
  assert.equal(body.max_tokens, 8192);
  assertWithinCeiling(body, 8192);
});

test('keeps adaptive-effort channels inside the ceiling without stacking a thinking budget', () => {
  const body = encodeAnthropic({
    effort: 'high',
    maxOutputTokens: 8192,
    reasoningParamStyle: 'anthropic-adaptive-effort',
  });

  assert.equal(body.thinking.budget_tokens, undefined);
  assert.equal(body.max_tokens, 8192);
  assertWithinCeiling(body, 8192);
});

test('stays inside a degenerate ceiling instead of overflowing it', () => {
  const body = encodeAnthropic({ effort: 'high', maxOutputTokens: 1 });

  assert.ok(body.max_tokens <= 1, `max_tokens ${body.max_tokens} 越过退化上限 1`);
});
