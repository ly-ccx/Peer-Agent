import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderProviderCandidates,
  resolveConversationModelBindingPatch,
  resolvePreferredProvider,
} from './provider-recovery-broker.mjs';

/**
 * orderProviderCandidates 的会话级首选 provider（preferredProviderId）测试。
 *
 * 命题：
 * - 指定的首选 provider 可运行时排为主 provider（primary）；
 * - 首选失效/被删/未配 Key 时，自动回退全局默认（isDefault）→ 首个可运行（强绑定回退）；
 * - 主 provider 之后仅跟随「同 model 的其它可运行 provider」作为故障转移候选。
 */
function p(overrides) {
  return { enabled: true, apiKeyConfigured: true, model: 'm', ...overrides };
}

test('preferredProviderId is ranked first when runnable', () => {
  const providers = [
    p({ id: 'a', isDefault: true, model: 'gpt' }),
    p({ id: 'b', isDefault: false, model: 'claude' }),
    p({ id: 'c', isDefault: false, model: 'gemini' }),
  ];
  const ordered = orderProviderCandidates(providers, 'b');
  assert.equal(ordered[0].id, 'b');
});

test('preferred provider carries same-model fallbacks behind it, not other models', () => {
  const providers = [
    p({ id: 'a', isDefault: true, model: 'gpt' }),
    p({ id: 'b', isDefault: false, model: 'claude' }),
    p({ id: 'b2', isDefault: false, model: 'claude' }), // 与 b 同 model → 作为故障转移候选
    p({ id: 'c', isDefault: false, model: 'gemini' }),
  ];
  const ordered = orderProviderCandidates(providers, 'b');
  assert.equal(ordered[0].id, 'b');
  const ids = ordered.map((x) => x.id);
  assert.deepEqual(ids, ['b', 'b2']); // 仅同 model 的 b2 跟随，gpt/gemini 不入列
});

test('strong-binding fallback: removed/invalid preferred falls back to default', () => {
  const providers = [
    p({ id: 'a', isDefault: true, model: 'gpt' }),
    p({ id: 'b', isDefault: false, model: 'claude' }),
  ];
  // 首选指向不存在的 provider（如会话残留的已删绑定）→ 回退默认 a。
  const ordered = orderProviderCandidates(providers, 'ghost');
  assert.equal(ordered[0].id, 'a');
});

test('strong-binding fallback: preferred without api key is skipped', () => {
  const providers = [
    p({ id: 'a', isDefault: true, model: 'gpt' }),
    p({ id: 'b', isDefault: false, model: 'claude', apiKeyConfigured: false }),
  ];
  // 首选 b 未配置 Key → 不可运行 → 回退默认 a。
  const ordered = orderProviderCandidates(providers, 'b');
  assert.equal(ordered[0].id, 'a');
});

test('no preferred falls back to default-first ordering', () => {
  const providers = [
    p({ id: 'a', isDefault: false, model: 'gpt' }),
    p({ id: 'b', isDefault: true, model: 'claude' }),
  ];
  const ordered = orderProviderCandidates(providers);
  assert.equal(ordered[0].id, 'b'); // isDefault 优先
});

test('empty when no runnable providers', () => {
  const providers = [p({ id: 'a', apiKeyConfigured: false })];
  assert.deepEqual(orderProviderCandidates(providers, 'a'), []);
});

test('resolvePreferredProvider matches legacy groupId::model', () => {
  const providers = [
    p({ id: 'uuid-default', groupId: 'grok-official', model: 'grok-3', isDefault: true }),
    p({ id: 'uuid-grok-45', groupId: 'grok-official', model: 'grok-4.5', isDefault: false }),
  ];
  const resolved = resolvePreferredProvider(providers, 'grok-official::grok-4.5');
  assert.equal(resolved?.id, 'uuid-grok-45');
});

test('orderProviderCandidates ranks legacy groupId::model first when runnable', () => {
  const providers = [
    p({ id: 'uuid-default', groupId: 'grok-official', model: 'grok-3', isDefault: true }),
    p({ id: 'uuid-grok-45', groupId: 'grok-official', model: 'grok-4.5', isDefault: false }),
  ];
  const ordered = orderProviderCandidates(providers, 'grok-official::grok-4.5');
  assert.equal(ordered[0].id, 'uuid-grok-45');
});

test('resolveConversationModelBindingPatch migrates legacy id when resolvable', () => {
  const providers = [
    p({ id: 'uuid-default', groupId: 'grok-official', model: 'grok-3', isDefault: true }),
    p({ id: 'uuid-grok-45', groupId: 'grok-official', model: 'grok-4.5', isDefault: false }),
  ];
  const patch = resolveConversationModelBindingPatch({
    providers,
    requestedModelProviderId: 'grok-official::grok-4.5',
    actualModelProviderId: 'uuid-default',
    actualModel: 'grok-3',
  });
  assert.equal(patch.modelProviderId, 'uuid-grok-45');
  assert.equal(patch.model, 'grok-3');
});

test('resolveConversationModelBindingPatch does not clobber unresolved binding with default', () => {
  const providers = [
    p({ id: 'uuid-default', groupId: 'grok-official', model: 'grok-3', isDefault: true }),
  ];
  const patch = resolveConversationModelBindingPatch({
    providers,
    requestedModelProviderId: 'missing-group::missing-model',
    actualModelProviderId: 'uuid-default',
    actualModel: 'grok-3',
  });
  assert.equal(Object.hasOwn(patch, 'modelProviderId'), false);
  assert.equal(patch.model, 'grok-3');
});

test('resolveConversationModelBindingPatch seeds unbound conversation with actual provider', () => {
  const patch = resolveConversationModelBindingPatch({
    providers: [p({ id: 'uuid-default', isDefault: true })],
    requestedModelProviderId: null,
    actualModelProviderId: 'uuid-default',
    actualModel: 'grok-3',
  });
  assert.equal(patch.modelProviderId, 'uuid-default');
  assert.equal(patch.model, 'grok-3');
});
