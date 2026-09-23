import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizeModelsDevEntry,
  reasoningEffortValuesFromOptions,
} from './models-dev-registry.mjs';
import { resolveChannel } from '../provider-channels.mjs';

function opencodeGoCapabilities(model, extraConfig = {}) {
  const resolved = resolveChannel({
    channelId: 'opencode-go',
    wireOverride: 'openai-chat',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKey: 'test-key',
    model,
    ...extraConfig,
  });
  return resolved.capabilities?.reasoning;
}

test('reasoningEffortValuesFromOptions 提取 effort values', () => {
  assert.deepEqual(
    reasoningEffortValuesFromOptions([
      { type: 'toggle' },
      { type: 'effort', values: ['Low', 'high', 'max'] },
    ]),
    ['low', 'high', 'max'],
  );
});

test('reasoningEffortValuesFromOptions 空声明返回 undefined（不发明档位）', () => {
  assert.equal(reasoningEffortValuesFromOptions([]), undefined);
  assert.equal(reasoningEffortValuesFromOptions(undefined), undefined);
  assert.equal(reasoningEffortValuesFromOptions([{ type: 'toggle' }]), undefined);
  assert.equal(reasoningEffortValuesFromOptions([{ type: 'effort', values: [] }]), undefined);
});

test('normalizeModelsDevEntry 透传 reasoningEffortValues', () => {
  const withEffort = normalizeModelsDevEntry({
    id: 'deepseek-v4-flash',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }],
  });
  assert.deepEqual(withEffort.reasoningEffortValues, ['low', 'high', 'max']);

  const withoutEffort = normalizeModelsDevEntry({
    id: 'mimo-v2.6-flash',
    reasoning: true,
    reasoning_options: [],
  });
  assert.equal(withoutEffort.reasoningEffortValues, undefined);
});

test('opencode-go 运行时：同步声明优先于静态表', () => {
  // deepseek-flash 静态表三档，同步声明只有两档时应采用同步声明。
  const reasoning = opencodeGoCapabilities('deepseek-flash', {
    reasoningEffortValues: ['high', 'max'],
  });
  assert.deepEqual(reasoning.effortLevels, ['high', 'max']);
  assert.deepEqual(reasoning.effortMap, { high: 'high', max: 'max' });
});

test('opencode-go 运行时：静态表兜底仍生效（deepseek-flash 三档）', () => {
  const reasoning = opencodeGoCapabilities('deepseek-flash');
  // 静态表 UI 级档位：low/default/high/xhigh(max)。
  assert.deepEqual(reasoning.effortLevels, ['low', 'default', 'high', 'xhigh', 'max']);
  assert.equal(reasoning.effortMap.low, 'low');
  assert.equal(reasoning.effortMap.max, 'max');
});

test('opencode-go 运行时：hy3 静态表兜底（none/low/high → off/低/高）', () => {
  const reasoning = opencodeGoCapabilities('hy3');
  assert.equal(reasoning.effortMap.off, 'none');
  assert.deepEqual(reasoning.effortLevels.includes('high'), true);
});

test('opencode-go 运行时：同步声明与静态表都未命中时保持单档 default', () => {
  const reasoning = opencodeGoCapabilities('mimo-v2.6-flash');
  assert.deepEqual(reasoning.effortLevels, ['default']);
  assert.deepEqual(reasoning.effortMap, {});
});

test('opencode-go 运行时：同步声明支持 off(none) 档', () => {
  const reasoning = opencodeGoCapabilities('mimo-v2.6-flash', {
    reasoningEffortValues: ['none', 'low', 'high'],
  });
  assert.equal(reasoning.effortMap.off, 'none');
  assert.equal(reasoning.effortMap.low, 'low');
  assert.equal(reasoning.effortMap.high, 'high');
});

test('deepseek 官方渠道档位不回归', () => {
  const resolved = resolveChannel({
    channelId: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-flash',
    reasoningEffortLevels: ['off', 'low', 'high', 'max'],
  });
  assert.deepEqual(resolved.capabilities.reasoning.effortLevels, ['off', 'low', 'high', 'max']);
});
