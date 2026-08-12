import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readTasksPageSource = () => readFile(new URL('./TasksPage.tsx', import.meta.url), 'utf8');
const readAppSource = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
const readTaskOverviewStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('conversation rows visually distinguish read and unread status labels', async () => {
  const [tasksPageSource, styles] = await Promise.all([
    readTasksPageSource(),
    readTaskOverviewStyles(),
  ]);

  assert.match(tasksPageSource, /item\.source === 'conversation'/);
  assert.match(tasksPageSource, /item\.statusLabel === '已读'/);
  assert.match(tasksPageSource, /task-action-owner--\$\{visualStatus\}/);
  assert.match(tasksPageSource, /task-status-dot--\$\{visualStatus\}/);
  assert.match(
    styles,
    /\.task-action-owner--unread\s*\{[\s\S]*?color: var\(--za-accent\);/,
  );
  assert.match(
    styles,
    /\.task-action-owner--read\s*\{[\s\S]*?color: var\(--za-text-muted\);/,
  );
  assert.match(styles, /\.task-status-dot--unread\s*\{[\s\S]*?var\(--za-accent\)/);
});

test('task row view button opens the matching task details', async () => {
  const [tasksPageSource, appSource] = await Promise.all([
    readTasksPageSource(),
    readAppSource(),
  ]);

  assert.match(tasksPageSource, /readonly onOpenItem\?: \(item: TaskOverviewItem\) => void;/);
  assert.match(
    tasksPageSource,
    /if \(item\.source === 'conversation'\) return item\.statusLabel;/,
  );
  assert.match(
    tasksPageSource,
    /className="task-row-open"[\s\S]*?onClick=\{\(\) => onOpenItem\?\.\(item\)\}/,
  );
  const openItemHandler =
    appSource.match(/<TasksPage[\s\S]*?onOpenItem=\{\(item\) => \{[\s\S]*?\n                            \}\}/)?.[0] ?? '';
  assert.match(openItemHandler, /if \(!item\.conversationId\) return;/);
  assert.match(openItemHandler, /handleContinueTask\(String\(item\.conversationId\)\);/);
  assert.doesNotMatch(openItemHandler, /planId|goalPlansMarkRequestedUserInput/);
});
