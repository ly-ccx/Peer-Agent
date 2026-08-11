import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  hasBoundAutomationWorkspace,
  workspaceForExistingAutomation,
  workspaceForNewAutomation,
} from './automationWorkspaceBinding.ts';

test('new automations bind to the current application workspace', () => {
  assert.equal(workspaceForNewAutomation('/workspaces/current'), '/workspaces/current');
});

test('editing an automation preserves its existing workspace', () => {
  assert.equal(workspaceForExistingAutomation('/workspaces/existing'), '/workspaces/existing');
});

test('empty or whitespace-only workspace bindings are rejected', () => {
  assert.equal(hasBoundAutomationWorkspace(''), false);
  assert.equal(hasBoundAutomationWorkspace('   '), false);
  assert.equal(hasBoundAutomationWorkspace('/workspaces/current'), true);
});

test('Automation editor displays workspace binding without an editable path control', async () => {
  const center = await readFile(new URL('./AutomationCenter.tsx', import.meta.url), 'utf8');

  assert.match(center, /workspacePath: workspaceForNewAutomation\(defaultWorkspace\)/);
  assert.match(center, /workspacePath: workspaceForExistingAutomation\(value\.workspacePath\)/);
  assert.match(center, /className="automation-bound-workspace top-meta"/);
  assert.match(center, /<strong>\{draft\.workspacePath \|\| '—'\}<\/strong>/);
  assert.equal(center.includes('automation-bound-workspace compact'), false);
  assert.equal(center.includes("update('workspacePath'"), false);
  assert.equal(center.includes('placeholder="/path/to/project"'), false);

  const topMetaAt = center.indexOf('className="automation-bound-workspace top-meta"');
  const formAt = center.indexOf('className="automation-form modern automation-form-single"');
  assert.ok(topMetaAt > 0 && formAt > topMetaAt, 'workspace binding should sit above the main form');
});

test('Automation editor blocks creation and saving without a bound workspace', async () => {
  const center = await readFile(new URL('./AutomationCenter.tsx', import.meta.url), 'utf8');

  assert.match(center, /if \(!definition && !hasBoundAutomationWorkspace\(defaultWorkspace\)\)/);
  assert.match(center, /if \(!hasBoundAutomationWorkspace\((?:draft|nextDraft)\.workspacePath\)\)/);
  assert.match(center, /setError\(copy\.workspaceRequired\)/);
});
