import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const i18nUrl = new URL('./automationI18n.ts', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation new page is a natural-language create home with prefilled template', async () => {
  const [center, i18n, css] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(i18nUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  assert.match(center, /blankDraft\(defaultWorkspace, copy\.promptTemplate\)/);
  assert.match(center, /automation-create-home/);
  assert.match(center, /className="automation-create-home-card"/);
  assert.match(center, /className="automation-create-home-prompt"/);
  assert.match(center, /copy\.createHomeTitle/);
  assert.match(center, /copy\.createHomeLede/);
  assert.match(center, /copy\.createHomeHint/);

  // Create home keeps detection model compact; generated plan stays progressive.
  assert.match(center, /automation-detect-model compact/);
  assert.match(center, /\{detected \|\| editing \? \(/);
  assert.match(center, /\{\(editing \|\| detected\) \? \(/);

  assert.match(i18n, /promptTemplate: `Every weekday morning:/);
  assert.match(i18n, /promptTemplate: `每个工作日早上：/);
  assert.match(i18n, /createHomeTitle: 'New automation task'/);
  assert.match(i18n, /createHomeTitle: '新建自动化任务'/);
  assert.match(i18n, /createHomeLede: 'Describe the recurring work in natural language/);
  assert.match(i18n, /createHomeLede: '用自然语言描述要重复执行的工作/);

  assert.match(css, /\.automation-create-home-card\{/);
  assert.match(css, /\.automation-create-home-prompt\{/);
  assert.match(css, /\.automation-detect-model\.compact\{/);
});
