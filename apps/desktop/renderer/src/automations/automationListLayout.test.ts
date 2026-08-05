import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const centerUrl = new URL('./AutomationCenter.tsx', import.meta.url);
const cssUrl = new URL('./automations.css', import.meta.url);

test('Automation list header is title + lede without stacked eyebrow', async () => {
  const center = await readFile(centerUrl, 'utf8');
  const listStart = center.indexOf('data-automation-view="list"');
  const listEnd = center.indexOf('data-automation-view="editor"');
  assert.ok(listStart > 0, 'list view should exist');
  const list = center.slice(listStart, listEnd > listStart ? listEnd : undefined);

  assert.match(list, /className="automation-page-heading"/);
  assert.match(list, /className="automation-page-lede"/);
  assert.match(list, /\{copy\.automations\}/);
  assert.match(list, /\{copy\.subtitle\}/);
  assert.equal(list.includes('automation-eyebrow'), false);
  assert.equal(list.includes('copy.operations'), false);
});

test('Automation list search sits inside list toolbar panel, not a freestanding row', async () => {
  const [center, css] = await Promise.all([
    readFile(centerUrl, 'utf8'),
    readFile(cssUrl, 'utf8'),
  ]);

  const listStart = center.indexOf('data-automation-view="list"');
  const listEnd = center.indexOf('data-automation-view="editor"');
  const list = center.slice(listStart, listEnd > listStart ? listEnd : undefined);

  assert.match(list, /className="automation-list-panel"/);
  assert.match(list, /className="automation-list-toolbar"/);
  assert.match(list, /aria-label=\{copy\.search\}/);
  assert.equal(list.includes('automation-toolbar'), false);

  const panelAt = list.indexOf('className="automation-list-panel"');
  const toolbarAt = list.indexOf('className="automation-list-toolbar"');
  const emptyAt = list.indexOf('className="automation-empty modern"');
  assert.ok(panelAt >= 0 && toolbarAt > panelAt, 'toolbar should live inside the list panel');
  assert.ok(emptyAt < 0 || emptyAt > toolbarAt, 'search should sit above list/empty content');

  assert.match(css, /\.automation-list-panel\{[^}]*background:var\(--paper-sheet\)/);
  assert.match(css, /\.automation-list-toolbar\{[^}]*justify-content:flex-end/);
  assert.match(css, /\.automation-list-toolbar\{[^}]*border-bottom:1px solid var\(--za-line\)/);
  assert.match(css, /\.automation-list-toolbar input\{[^}]*background:var\(--za-control-fill\)/);
  assert.equal(css.includes('.automation-toolbar{'), false);
});
