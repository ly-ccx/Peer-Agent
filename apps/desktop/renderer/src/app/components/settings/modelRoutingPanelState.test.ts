import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  isRoutingReadOnly,
  moveListItem,
  optionRejectReason,
  roleTranslationKey,
  routingMenuGroups,
  routingReasoningLevels,
  setRoutingReasoning,
  validateAutoPool,
  type RoutingModelOption,
} from './modelRoutingPanelState.ts';

const text: RoutingModelOption = {
  id: 'text',
  label: 'Text',
  supportsVision: false,
  supportsTools: true,
  supportsStructured: true,
  contextTokens: 32_000,
};
const vision: RoutingModelOption = {
  id: 'vision',
  label: 'Vision',
  supportsVision: true,
  supportsTools: false,
  supportsStructured: false,
  contextTokens: 4_000,
};

const I18N_KEYS = [
  'modelRouting.nav',
  'modelRouting.title',
  'modelRouting.description',
  'modelRouting.singleModel',
  'modelRouting.noModel',
  'modelRouting.tiers',
  'modelRouting.roles',
  'modelRouting.primary',
  'modelRouting.fallbacks',
  'modelRouting.addFallback',
  'modelRouting.moveUp',
  'modelRouting.moveDown',
  'modelRouting.remove',
  'modelRouting.mode.tier',
  'modelRouting.mode.fixed',
  'modelRouting.mode.auto',
  'modelRouting.pool',
  'modelRouting.poolInvalid',
  'modelRouting.resolved',
  'modelRouting.reasoning',
  'modelRouting.reasoningDefault',
  'modelRouting.reasoningInvalid',
  'modelRouting.reasoningNoCommon',
  'modelRouting.unresolved',
  'modelRouting.preferDifferentFamily',
  'modelRouting.spendCap',
  'modelRouting.spendExceeded',
  'modelRouting.essentialSpend',
  'modelRouting.tier.strong',
  'modelRouting.tier.fast',
  'modelRouting.tier.economy',
  'modelRouting.tier.vision',
  'modelRouting.role.project_agent',
  'modelRouting.role.session_worker',
  'modelRouting.role.explorer',
  'modelRouting.role.verifier',
  'modelRouting.role.visual_verifier',
  'modelRouting.role.memory_curator',
  'modelRouting.role.objective_probe',
  'modelRouting.role.compactor',
  'modelRouting.reason.vision',
  'modelRouting.reason.tools',
  'modelRouting.reason.structured',
  'modelRouting.reason.context',
  'modelRouting.loadFailed',
  'modelRouting.saveFailed',
  'settings.usage.byRole',
  'settings.usage.showByRole',
  'settings.usage.col.role',
] as const;

test('vision tier and visual role grey out models that cannot see images', () => {
  assert.equal(optionRejectReason(text, { kind: 'tier', tier: 'vision' }), 'vision');
  assert.equal(optionRejectReason(vision, { kind: 'tier', tier: 'vision' }), null);
  assert.equal(optionRejectReason(text, { kind: 'tier', tier: 'economy' }), null);
  assert.equal(optionRejectReason(text, { kind: 'role', role: 'visual_verifier' }), 'vision');
  assert.equal(optionRejectReason(vision, { kind: 'role', role: 'explorer' }), 'tools');
  assert.equal(optionRejectReason({ ...text, contextTokens: 1000 }, { kind: 'role', role: 'explorer' }), 'context');
  assert.equal(optionRejectReason(vision, { kind: 'role', role: 'memory_curator' }), 'structured');
});

test('routing menu groups models by channel and greys out the wrong capability', () => {
  const flash = { ...text, id: 'ds-flash', label: 'deepseek-flash', providerName: 'DeepSeek', groupId: 'deepseek', model: 'deepseek-flash' };
  const pro = { ...text, id: 'ds-pro', label: 'deepseek-pro', providerName: 'DeepSeek', groupId: 'deepseek', model: 'deepseek-pro' };
  const glm = { ...vision, id: 'glm', label: 'GLM-5.3', providerName: '智谱', groupId: 'zhipu', model: 'glm-5.3' };
  const groups = routingMenuGroups([flash, pro, glm], { kind: 'tier', tier: 'vision' }, true, () => '不能看图');
  assert.deepEqual(groups.map((group) => group.label), ['DeepSeek', '智谱']);
  assert.deepEqual(groups[0]?.items.map((item) => item.id), ['ds-flash', 'ds-pro']);
  assert.equal(groups[0]?.items.every((item) => item.disabled), true);
  assert.equal(groups[1]?.items[0]?.disabled, false);
  assert.equal(groups[0]?.disabled, true);
});

test('one usable model still allows role reasoning configuration', () => {
  assert.equal(isRoutingReadOnly(1), false);
  assert.equal(isRoutingReadOnly(0), true);
  assert.equal(isRoutingReadOnly(2), false);
});

test('an automatic pool must be non-empty and inside the role capability set', () => {
  assert.deepEqual(validateAutoPool([], [text, vision], 'explorer'), { ok: false, reason: 'empty' });
  assert.deepEqual(validateAutoPool(['missing'], [text], 'explorer'), { ok: false, reason: 'unknown' });
  assert.deepEqual(validateAutoPool(['text'], [text, vision], 'visual_verifier'), { ok: false, reason: 'capability' });
  assert.deepEqual(validateAutoPool(['vision'], [text, vision], 'visual_verifier'), { ok: true });
  assert.deepEqual(validateAutoPool(['text'], [text, vision], 'explorer'), { ok: true });
});

test('fallback order moves inside the list and stays put at the ends', () => {
  assert.deepEqual(moveListItem(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveListItem(['a', 'b'], 'a', -1), ['a', 'b']);
  assert.deepEqual(moveListItem(['a', 'b'], 'b', 1), ['a', 'b']);
});

test('reasoning choices intersect the declared eligible candidates without pinning a tier', () => {
  const a = { ...text, id: 'a', reasoningEffortLevels: ['high', 'max'] as const };
  const b = { ...text, id: 'b', reasoningEffortLevels: ['low', 'high'] as const };
  const tiers = { strong: { primary: 'a', fallbacks: ['b'] } };
  const tier = { mode: 'tier' as const, tier: 'strong' as const };
  assert.deepEqual(routingReasoningLevels(tier, tiers, [a, b], 'session_worker'), ['high']);
  assert.deepEqual(routingReasoningLevels({ mode: 'auto', pool: ['a', 'b'] }, tiers, [a, b], 'session_worker'), ['high']);
  assert.deepEqual(routingReasoningLevels({ mode: 'fixed', modelProviderId: 'a' }, tiers, [a, b], 'session_worker'), ['high', 'max']);
  assert.deepEqual(routingReasoningLevels(tier, tiers, [a, { ...b, reasoningEffortLevels: undefined }], 'session_worker'), []);
  const changed = setRoutingReasoning(tier, 'high');
  assert.deepEqual(changed, { mode: 'tier', tier: 'strong', reasoningEffort: 'high' });
  assert.deepEqual(setRoutingReasoning(changed), tier);
});

test('model routing copy exists in both locales', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');
  for (const key of I18N_KEYS) {
    assert.notEqual(zh.t(key), key, key);
    assert.notEqual(en.t(key), key, key);
    assert.equal(roleTranslationKey('explorer'), 'modelRouting.role.explorer');
  }
  assert.match(zh.t('modelRouting.singleModel'), /分别设置思考强度/);
  assert.notEqual(en.t('modelRouting.singleModel'), zh.t('modelRouting.singleModel'));
});

test('LlmSettingsPanel.tsx keeps its smaller extracted baseline', () => {
  const source = readFileSync(new URL('../LlmSettingsPanel.tsx', import.meta.url), 'utf8');
  const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
  assert.ok(lines <= 2214, 'extraction may shrink the module without increasing its budget');
});
