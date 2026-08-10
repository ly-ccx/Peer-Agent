import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./ChatHeader.tsx', import.meta.url), 'utf8');

test('ChatHeader only renders Workbench controls when a provider is available', async () => {
  const source = await readSource();

  assert.match(source, /const workbench = useWorkbenchOptional\(\);/);
  assert.match(source, /\{workbench \? <SidebarToggle isZh=\{isZh\} \/> : null\}/);
  assert.match(source, /\{workbench \? <WorkbenchToggle isZh=\{isZh\} \/> : null\}/);
  assert.doesNotMatch(source, /^\s*<SidebarToggle isZh=\{isZh\} \/>$/m);
  assert.doesNotMatch(source, /^\s*<WorkbenchToggle isZh=\{isZh\} \/>$/m);
});
