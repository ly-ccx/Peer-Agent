import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name: string) => readFile(new URL(name, import.meta.url), 'utf8');

test('create CTA can save with prompt-only draft via inference override', async () => {
  const center = await read('./AutomationCenter.tsx');
  assert.match(center, /const save = async \(draftOverride\?: Draft\)/);
  assert.match(center, /onSave=\{\(next\) => void save\(next\)\}/);
  assert.match(center, /const next = await runDetection\(true\)/);
  assert.match(center, /setConfirmOpen\(true\)/);
  assert.match(center, /onSave\(draft\)/);
  assert.match(center, /if \(editing\) \{\s+onSave\(\);/);
  assert.equal(center.includes('goNext'), false);
});

test('generated plan remains editable after first detection', async () => {
  const center = await read('./AutomationCenter.tsx');
  assert.match(center, /setNameTouched\(true\)/);
  assert.match(center, /setScheduleTouched\(true\)/);
  assert.match(center, /advancedSettings/);
});
