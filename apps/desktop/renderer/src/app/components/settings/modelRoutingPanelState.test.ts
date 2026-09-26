import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import {
  isRoutingReadOnly,
  moveListItem,
  optionRejectReason,
  roleTranslationKey,
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

test('one usable model makes the routing tables read only', () => {
  assert.equal(isRoutingReadOnly(1), true);
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

test('model routing copy exists in both locales', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');
  for (const key of I18N_KEYS) {
    assert.notEqual(zh.t(key), key, key);
    assert.notEqual(en.t(key), key, key);
    assert.equal(roleTranslationKey('explorer'), 'modelRouting.role.explorer');
  }
  assert.equal(zh.t('modelRouting.singleModel'), '只有一个模型时，所有工作都用它');
  assert.notEqual(en.t('modelRouting.singleModel'), zh.t('modelRouting.singleModel'));
});

test('LlmSettingsPanel.tsx keeps its line count', () => {
  const source = readFileSync(new URL('../LlmSettingsPanel.tsx', import.meta.url), 'utf8');
  const lines = source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
  assert.equal(lines, 2265);
});
