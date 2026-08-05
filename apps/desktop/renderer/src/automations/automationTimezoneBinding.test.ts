import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  systemAutomationTimezone,
  timezoneForExistingAutomation,
} from './automationTimezoneBinding.ts';

test('new automations bind to the resolved system timezone', () => {
  assert.equal(systemAutomationTimezone('Asia/Shanghai'), 'Asia/Shanghai');
  assert.equal(systemAutomationTimezone(' America/New_York '), 'America/New_York');
});

test('new automations fall back to UTC when the system timezone is unavailable', () => {
  assert.equal(systemAutomationTimezone(''), 'UTC');
  assert.equal(systemAutomationTimezone('   '), 'UTC');
});

test('editing an automation preserves its existing timezone', () => {
  assert.equal(timezoneForExistingAutomation('Europe/Berlin'), 'Europe/Berlin');
});

test('Automation editor displays the bound timezone without a text input', async () => {
  const center = await readFile(new URL('./AutomationCenter.tsx', import.meta.url), 'utf8');

  assert.match(center, /timezone: systemAutomationTimezone\(\)/);
  assert.match(center, /timezone: timezoneForExistingAutomation\(value\.schedule\.timezone\)/);
  assert.match(center, /className="automation-bound-timezone"/);
  assert.match(center, /<strong>\{draft\.timezone\}<\/strong>/);
  assert.equal(center.includes("update('timezone'"), false);
  assert.equal(center.includes('<input value={draft.timezone}'), false);
});

test('Automation save contract continues to carry the bound timezone', async () => {
  const center = await readFile(new URL('./AutomationCenter.tsx', import.meta.url), 'utf8');

  assert.match(center, /const schedule = \{\s*kind: draft\.scheduleKind, timezone: draft\.timezone,/);
  assert.match(center, /workspacePath: draft\.workspacePath\.trim\(\), schedule,/);
});
