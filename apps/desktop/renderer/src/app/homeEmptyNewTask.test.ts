import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('workbench empty state offers a new-task action wired to handleNewChat', async () => {
  const [app, home, overview] = await Promise.all([
    read('../App.tsx'),
    read('./pages/HomePage.tsx'),
    read('./pages/TaskOverviewPage.tsx'),
  ]);

  assert.match(app, /onNewTask=\{\(\) => \{\s*void handleNewChat\(\);\s*\}\}/);
  assert.match(home, /readonly onNewTask\?: \(\) => void;/);
  assert.match(home, /onNewTask=\{onNewTask\}/);
  assert.match(overview, /readonly onNewTask\?: \(\) => void;/);
  assert.match(overview, /发起新任务/);
  assert.match(overview, /onClick=\{onNewTask\}/);
});
