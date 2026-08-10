import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readTasksPageSource = () => readFile(new URL('./TasksPage.tsx', import.meta.url), 'utf8');
const readAppSource = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

test('task row view button opens the matching task details', async () => {
  const [tasksPageSource, appSource] = await Promise.all([
    readTasksPageSource(),
    readAppSource(),
  ]);

  assert.match(tasksPageSource, /readonly onOpenItem\?: \(item: TaskOverviewItem\) => void;/);
  assert.match(
    tasksPageSource,
    /className="task-row-open"[\s\S]*?onClick=\{\(\) => onOpenItem\?\.\(item\)\}/,
  );
  assert.match(
    appSource,
    /<TasksPage[\s\S]*?onOpenItem=\{\(item\) => \{[\s\S]*?setActiveConversationId\(String\(item\.conversationId\)\);[\s\S]*?setCollectionDrawer\('task_details'\);/,
  );
});
