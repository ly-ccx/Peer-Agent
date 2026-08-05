import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);
const i18nUrl = new URL('./automationI18n.ts', import.meta.url);

test('Automation editor header is a restrained title + lede, not stacked eyebrow layers', async () => {
  const [center, css, i18n] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
    readFile(i18nUrl, 'utf8'),
  ]);

  const editor = center.split('function Editor')[1]?.split('function AutomationDetail')[0] ?? '';

  assert.match(editor, /className="automation-page-header compact"/);
  assert.match(editor, /className="automation-page-heading"/);
  assert.match(editor, /className="automation-page-lede"/);
  assert.match(editor, /\{editing \? copy\.editTitle : copy\.createHomeTitle\}/);
  assert.match(editor, /\{editing \? copy\.editorSubtitle : copy\.createHomeLede\}/);

  // No third stacked eyebrow layer in the create/edit header.
  assert.equal(editor.includes('automation-eyebrow'), false);
  assert.equal(editor.includes('copy.newDelegation'), false);
  assert.equal(editor.includes('copy.editDefinition'), false);

  assert.match(css, /\.automation-editor \.automation-page-heading\{display:grid;gap:8px;max-width:40rem\}/);
  assert.match(css, /\.automation-editor \.automation-page-header\.compact h1\{font-size:26px;line-height:1\.15/);
  assert.match(css, /\.automation-editor \.automation-page-lede\{color:var\(--za-text-muted\);font-size:13\.5px;line-height:1\.55/);
  assert.match(css, /\.automation-editor \.automation-page-header\.compact\{margin:4px 0 22px;max-width:760px\}/);

  assert.match(i18n, /editorSubtitle: 'Describe the recurring work\. Name and schedule are generated after detection\.'/);
  assert.match(i18n, /editorSubtitle: '描述要重复执行的工作，名称与计划会自动生成。'/);
});
