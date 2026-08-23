import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readAppSource = () => readFile(new URL('../App.tsx', import.meta.url), 'utf8');

test('app boots into the current task page by default', async () => {
  const app = await readAppSource();
  assert.match(app, /const \[activePage, setActivePage\] = useState<AppPage>\('chat'\);/);
  assert.doesNotMatch(app, /const \[activePage, setActivePage\] = useState<AppPage>\('home'\);/);
});
