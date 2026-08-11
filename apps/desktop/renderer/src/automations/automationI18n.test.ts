import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { automationCopy, getAutomationCopy } from './automationI18n.ts';
import { formatDateTime, runStatusLabel, scheduleLabel } from './automationPresentation.ts';

test('Automation English and Chinese dictionaries expose the same complete key set', () => {
  assert.deepEqual(Object.keys(automationCopy.zh).sort(), Object.keys(automationCopy.en).sort());
  assert.equal(getAutomationCopy(false).automations, 'Automation tasks');
  assert.equal(getAutomationCopy(true).automations, '自动化任务');
  assert.equal(getAutomationCopy(true).createAutomation, '创建自动化任务');
  assert.equal(getAutomationCopy(true).immutableReceipt, '不可变结果收据');
});

test('Automation schedule, dates and run statuses follow the selected locale', () => {
  const schedule = { kind: 'daily' as const, timezone: 'Asia/Shanghai', hour: 9, minute: 5 };
  assert.equal(scheduleLabel(schedule, 'en'), 'Daily · 09:05');
  assert.equal(scheduleLabel(schedule, 'zh'), '每天 · 09:05');
  assert.equal(runStatusLabel('waiting_permission', 'en'), 'Waiting for permission');
  assert.equal(runStatusLabel('waiting_permission', 'zh'), '等待授权');
  assert.match(formatDateTime('2026-01-02T03:04:00.000Z', 'en'), /2026/);
  assert.match(formatDateTime('2026-01-02T03:04:00.000Z', 'zh'), /2026/);
});

test('App wires session isZh into Automation Center and visible copy stays centralized', async () => {
  const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const center = await readFile(new URL('./AutomationCenter.tsx', import.meta.url), 'utf8');

  assert.match(app, /<AutomationCenter[\s\S]*?isZh=\{isZh\}/);
  assert.match(center, /const copy = getAutomationCopy\(isZh\)/);

  const forbiddenVisibleEnglish = [
    '>Automation tasks<', '>New automation<', '>Pause all<', '>Create automation<',
    '>No runs yet<', '>Immutable result receipt<', '>Open conversation<',
    'placeholder="Search automations"', 'label="Next run"', 'label="Workspace"',
  ];
  for (const value of forbiddenVisibleEnglish) {
    assert.equal(center.includes(value), false, `AutomationCenter must not hard-code visible copy: ${value}`);
  }
});
