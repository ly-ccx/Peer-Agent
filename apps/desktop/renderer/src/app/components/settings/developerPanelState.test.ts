import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createI18n } from '@peer-agent/i18n';
import { projectAgentModeEnabled } from './developerPanelState.ts';

const KEYS = [
  'developer.projectAgent.nav',
  'developer.projectAgent.title',
  'developer.projectAgent.description',
  'developer.projectAgent.switch',
  'developer.projectAgent.diagnostics',
  'developer.projectAgent.inactive',
] as const;

test('project agent mode defaults off unless the stored value is true', () => {
  assert.equal(projectAgentModeEnabled(undefined), false);
  assert.equal(projectAgentModeEnabled(null), false);
  assert.equal(projectAgentModeEnabled({}), false);
  assert.equal(projectAgentModeEnabled({ projectAgentMode: false }), false);
  assert.equal(projectAgentModeEnabled({ projectAgentMode: 'true' }), false);
  assert.equal(projectAgentModeEnabled({ projectAgentMode: true }), true);
});

test('developer copy exists in both locales and the shell does not read the flag', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en-US');
  for (const key of KEYS) {
    assert.notEqual(zh.t(key), key, key);
    assert.notEqual(en.t(key), key, key);
  }
  assert.equal(zh.t('developer.projectAgent.inactive'), '未启用');
  const app = readFileSync(new URL('../../../App.tsx', import.meta.url), 'utf8');
  assert.equal(app.includes('projectAgentMode'), false);
  assert.equal(app.includes('useDeveloperFlag'), false);
});
