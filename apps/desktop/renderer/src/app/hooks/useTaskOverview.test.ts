import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHook = () => readFile(new URL('./useTaskOverview.ts', import.meta.url), 'utf8');

test('pausing TaskOverview refresh keeps the currently rendered projection', async () => {
  const source = await readHook();
  const disabledBranch = source.match(/if \(!enabled\) \{([\s\S]*?)\n\s*\}/)?.[1];

  assert.ok(disabledBranch, 'reload should retain an explicit disabled guard');
  assert.doesNotMatch(
    disabledBranch,
    /setItems\(\[\]\)/,
    'pausing refresh must not replace the visible projection with an empty list',
  );
  assert.match(disabledBranch, /return;/);
});

test('resuming TaskOverview refresh still reloads from the main-owned projection', async () => {
  const source = await readHook();

  assert.match(source, /useEffect\(\(\) => \{\s*void reload\(\);\s*\}, \[reload\]\)/);
  assert.match(source, /clientApi\.taskOverviewList\(/);
});
