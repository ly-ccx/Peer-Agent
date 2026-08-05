import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFile(new URL(path, root), 'utf8');

const businessFiles = [
  'app/components/AppshotsPanel.tsx',
  'app/components/LlmSettingsPanel.tsx',
  'app/components/McpSettingsPanel.tsx',
  'app/components/ModelCatalogDialog.tsx',
  'automations/AutomationCenter.tsx',
  'capabilities/components/SkillDetailDialog.tsx',
  'capabilities/components/SkillsInstalledPanel.tsx',
  'workbench/views/SessionImportWizard.tsx',
] as const;

test('Switch exposes one governed native button switch contract', async () => {
  const source = await read('ui/boolean-controls/Switch.tsx');

  assert.match(source, /<button/);
  assert.match(source, /type=\{type\}/);
  assert.match(source, /role="switch"/);
  assert.match(source, /aria-checked=\{checked\}/);
  assert.match(source, /disabled=\{disabled\}/);
  assert.match(source, /onCheckedChange\(!checked\)/);
  assert.match(source, /data-state=\{checked \? 'checked' : 'unchecked'\}/);
});

test('Checkbox preserves native input semantics and uses an SVG state mark', async () => {
  const source = await read('ui/boolean-controls/Checkbox.tsx');

  assert.match(source, /type="checkbox"/);
  assert.match(source, /<svg/);
  assert.match(source, /aria-hidden="true"/);
  assert.equal(source.includes('✓'), false);
});

test('boolean control CSS uses only declared Peer Frost tokens and all required states', async () => {
  const [css, tokens] = await Promise.all([
    read('ui/boolean-controls/boolean-controls.css'),
    read('styles/tokens.css'),
  ]);
  const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
  const used = [...new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))];

  assert.deepEqual(used.filter((token) => !declared.has(token)), []);
  assert.equal(/#[0-9a-f]{3,8}\b/i.test(css), false);
  for (const selector of [
    ':hover:not(:disabled)', ':focus-visible', '[data-state="checked"]',
    ':disabled', ':checked', 'prefers-reduced-motion',
  ]) {
    assert.equal(css.includes(selector), true, `missing boolean control state: ${selector}`);
  }
  for (const token of [
    '--control-fill', '--control-fill-hover', '--graphite-hairline',
    '--graphite-fade', '--state-active-on', '--paper-sheet', '--azure-seal',
  ]) {
    assert.equal(css.includes(`var(${token})`), true, `missing semantic token role: ${token}`);
  }
});

test('all product boolean usages follow the 9 Switch and 2 Checkbox semantic matrix', async () => {
  const sources = await Promise.all(businessFiles.map(read));
  const joined = sources.join('\n');

  assert.equal((joined.match(/<Switch\b/g) ?? []).length, 9);
  assert.equal((joined.match(/<Checkbox\b/g) ?? []).length, 2);
  assert.equal(joined.includes('type="checkbox"'), false);
  assert.equal(joined.includes('role="switch"'), false);

  assert.match(await read('automations/AutomationCenter.tsx'), /<Switch\s+checked=\{draft\.notifySuccess\}/);
  assert.match(await read('app/components/ModelCatalogDialog.tsx'), /<Checkbox checked=\{checked\}/);
  assert.match(await read('workbench/views/SessionImportWizard.tsx'), /<Checkbox\s+checked=\{checked\}/);
});

test('legacy private toggle implementations are removed', async () => {
  const [capabilityCss, automationCss, llmCss] = await Promise.all([
    read('capabilities/capability-workbench.css'),
    read('automations/automations.css'),
    read('styles/llm-settings.css'),
  ]);

  for (const legacy of ['skill-toggle', 'skill-detail-toggle', 'automation-checkbox']) {
    assert.equal(`${capabilityCss}\n${automationCss}\n${llmCss}`.includes(legacy), false, `legacy selector remains: ${legacy}`);
  }
  assert.equal(llmCss.includes('input[type="checkbox"]'), false);
});

test('global stylesheet loads boolean control styles after tokens', async () => {
  const styles = await read('styles.css');
  const tokenIndex = styles.indexOf('@import "./styles/tokens.css"');
  const controlIndex = styles.indexOf('@import "./ui/boolean-controls/boolean-controls.css"');

  assert.notEqual(tokenIndex, -1);
  assert.notEqual(controlIndex, -1);
  assert.equal(tokenIndex < controlIndex, true);
});
