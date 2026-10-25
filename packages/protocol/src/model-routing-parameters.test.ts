import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoleModel, routingParameters, type CatalogModel, type ModelRoutingSettings, type RoleSetting } from './model-routing.ts';

const catalog: CatalogModel[] = [{ modelProviderId: 'm', modelId: 'm', providerId: 'p', family: 'p',
  tools: true, supportsFastMode: true, reasoningEffort: 'low', reasoningEffortLevels: ['low', 'high'] }];
function routing(setting: RoleSetting): ModelRoutingSettings {
  return { tiers: { strong: { primary: 'm', reasoningEffort: 'high', fastMode: true } },
    roles: { session_worker: setting }, verifierPreferDifferentFamily: false };
}

test('tier parameters are inherited and explicit null/false override independently', () => {
  for (const [override, effort, fast] of [
    [{}, 'high', true], [{ reasoningEffort: null }, 'low', true],
    [{ fastMode: false }, 'high', false], [{ reasoningEffort: 'low', fastMode: false }, 'low', false],
  ] as const) {
    const config = routing({ mode: 'tier', tier: 'strong', ...override });
    const before = JSON.stringify(config);
    const result = resolveRoleModel({ role: 'session_worker', catalog, routing: config });
    if (!result.ok) assert.fail(result.missing);
    assert.equal(result.selection.reasoningEffort, effort);
    assert.equal(result.selection.fastMode, fast);
    assert.equal(JSON.stringify(config), before);
  }
});

test('fixed and automatic modes use their own parameters without inheriting an unrelated tier', () => {
  for (const setting of [{ mode: 'fixed', modelProviderId: 'm' }, { mode: 'auto', pool: ['m'] }] as const) {
    assert.deepEqual(routingParameters(setting, routing(setting).tiers), { reasoningEffort: undefined, fastMode: false });
    const result = resolveRoleModel({ role: 'session_worker', catalog, routing: routing({ ...setting, fastMode: true, reasoningEffort: 'high' }) });
    assert.equal(result.ok && result.selection.fastMode, true);
  }
});

test('unsupported inherited parameters fail without changing model or dropping the requested channel', () => {
  const config = routing({ mode: 'tier', tier: 'strong' });
  const noFast = resolveRoleModel({ role: 'session_worker', catalog: [{ ...catalog[0]!, supportsFastMode: false }], routing: config });
  assert.equal(!noFast.ok && noFast.reason, 'fast_mode');
  const noEffort = resolveRoleModel({ role: 'session_worker', catalog: [{ ...catalog[0]!, reasoningEffortLevels: ['low'] }], routing: config });
  assert.equal(!noEffort.ok && noEffort.reason, 'reasoning');
  assert.equal(config.tiers.strong?.primary, 'm');
  assert.equal(config.tiers.strong?.fastMode, true);
});
