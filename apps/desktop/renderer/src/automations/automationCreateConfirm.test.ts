import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const i18nUrl = new URL('./automationI18n.ts', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation create flow selects a detection model and opens a confirmation card', async () => {
  const [center, i18n, css] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(i18nUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  assert.match(center, /detectModelId/);
  assert.match(center, /llmListChatProviders/);
  assert.match(center, /llmComplete/);
  assert.match(center, /buildAutomationDetectionPrompt/);
  assert.match(center, /parseLlmAutomationDetectionText/);
  assert.match(center, /setConfirmOpen\(true\)/);
  assert.match(center, /import \{ Overlay \} from '\.\.\/app\/components\/Overlay'/);
  assert.match(center, /backdropClassName="automation-confirm-overlay"/);
  assert.match(center, /panelClassName="automation-confirm-card"/);
  assert.equal(center.includes('aria-modal="true"'), false);
  assert.match(center, /copy\.confirmAndEnable/);
  assert.match(center, /onSave\(draft\)/);

  // Create path must open confirmation instead of saving immediately.
  const onPrimaryAt = center.indexOf('const onPrimary = () =>');
  const onPrimaryEnd = center.indexOf('const confirmSchedule', onPrimaryAt);
  const onPrimary = center.slice(onPrimaryAt, onPrimaryEnd > onPrimaryAt ? onPrimaryEnd : onPrimaryAt + 800);
  assert.match(onPrimary, /setConfirmOpen\(true\)/);
  assert.match(onPrimary, /runDetection\(true\)/);
  // Direct save in onPrimary should only remain for edit mode.
  assert.match(onPrimary, /if \(editing\) \{[\s\S]*?onSave\(\);/);
  assert.doesNotMatch(onPrimary.replace(/if \(editing\) \{[\s\S]*?return;\n\s*\}/, ''), /onSave\(/);

  assert.match(i18n, /detectModel: 'Detection model'/);
  assert.match(i18n, /detectModel: '检测模型'/);
  assert.match(i18n, /confirmAndEnable: 'Confirm & enable'/);
  assert.match(i18n, /confirmAndEnable: '确认并启用'/);

  assert.match(css, /\.automation-confirm-overlay\{/);
  assert.match(css, /\.automation-confirm-card\{/);
  assert.match(css, /\.automation-detect-model\{/);
});
