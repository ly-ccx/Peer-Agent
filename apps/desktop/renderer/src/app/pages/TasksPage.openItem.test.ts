import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readTasksPageSource = () => readFile(new URL('./TasksPage.tsx', import.meta.url), 'utf8');
const readAppSource = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');
const readTaskOverviewStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('task rows expose durable one-click read and redundant unread visual cues', async () => {
  const [tasksPageSource, styles] = await Promise.all([
    readTasksPageSource(),
    readTaskOverviewStyles(),
  ]);

  assert.match(tasksPageSource, /activeItems\.filter\(\(item\) => item\.isUnread && item\.conversationId\)/);
  assert.match(tasksPageSource, /await clientApi\.taskOverviewMarkRead\(\{ conversationIds \}\)/);
  assert.match(tasksPageSource, /未读 \{unreadItems\.length\}/);
  assert.match(tasksPageSource, /一键已读/);
  assert.doesNotMatch(tasksPageSource, /setUnreadOnly|aria-pressed=\{unreadOnly\}/);
  assert.match(tasksPageSource, /item\.isUnread \? <em className="task-new-activity">新动态<\/em>/);
  assert.match(tasksPageSource, /task-status-dot--\$\{visualStatus\}/);
  assert.match(styles, /\.task-record--unread\s*\{/);
  assert.match(styles, /\.task-record--unread \.task-record-title strong\s*\{/);
  assert.match(styles, /\.task-new-activity\s*\{/);
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
  assert.match(openItemHandler, /handleSelectConversation\(String\(item\.conversationId\)\);/);
  assert.match(openItemHandler, /focusTaskRelatedMessage\(item\)/);
  assert.match(openItemHandler, /openResultDrawer\(item\)/);
  assert.doesNotMatch(openItemHandler, /planId|goalPlansMarkRequestedUserInput/);
});

test('result_ready opens the drawer without focusing; other rights open the main task', async () => {
  const appSource = await readAppSource();
  const openItemHandlers = [...appSource.matchAll(/onOpenItem=\{\(item: TaskOverviewItem, options\?: OpenResultOptions\) => \{[\s\S]*?\n                      \}\}/g)]
    .map((match) => match[0]);
  assert.ok(openItemHandlers.length >= 2);
  for (const handler of openItemHandlers) {
    assert.match(handler, /result_ready'\) \{[\s\S]*?openResultDrawer\(item, options\);\s*\n\s*return;/);
    assert.doesNotMatch(handler, /openResultDrawer\(item, options\);\s*focusTaskRelatedMessage\(item\)/);
    assert.match(handler, /handleSelectConversation\(String\(conversationId\)\);\s*focusTaskRelatedMessage\(item\)/);
  }
  assert.match(appSource, /setNotificationMessageTarget\(\{/);
  assert.match(appSource, /resolveTaskRelatedMessageId\(item\)/);
  assert.ok(appSource.includes("from './chat/state/taskRelatedMessageResolve'"));
});
