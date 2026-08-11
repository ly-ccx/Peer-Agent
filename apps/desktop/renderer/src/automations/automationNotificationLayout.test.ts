import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');

test('notification label and Switch form one associated setting row', async () => {
  const center = await read('./AutomationCenter.tsx');

  assert.match(center, /className="automation-setting-row" onClick=\{\(\) => update\('notifySuccess', !draft\.notifySuccess\)\}/);
  assert.match(center, /id="automation-notify-success-label"/);
  assert.match(center, /aria-labelledby="automation-notify-success-label"/);
  assert.match(center, /onClick=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(center, /onCheckedChange=\{\(checked\) => update\('notifySuccess', checked\)\}/);
  assert.match(center, /automation-setting-copy/);
});

test('notification setting row keeps label and Switch as one full-width control group', async () => {
  const css = await read('./automations.css');
  const rule = css.match(/\.automation-setting-row\{([^}]+)\}/)?.[1] ?? '';

  assert.match(rule, /display:flex/);
  assert.match(rule, /justify-content:space-between/);
  assert.match(rule, /gap:16px/);
  assert.equal(rule.includes('position:absolute'), false);
});
