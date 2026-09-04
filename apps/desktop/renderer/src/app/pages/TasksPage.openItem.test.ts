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
  assert.match(openItemHandler, /if \(!item\.conversationId\) \{/);
  assert.match(openItemHandler, /setWorkbenchOpenNotice\(MISSING_WORKBENCH_CONVERSATION_NOTICE\)/);
  assert.match(appSource, /className="workbench-open-notice"/);
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
    assert.match(handler, /resolveWorkbenchConversationId\(item\)/);
    assert.match(handler, /handleSelectConversation\(String\(conversationId\), item\.deliveryWorkspacePath \?\? null\);/);
    assert.match(handler, /focusTaskRelatedMessage\(\{ \.\.\.item, conversationId \}\)/);
  }
  assert.match(appSource, /setNotificationMessageTarget\(\{/);
  assert.match(appSource, /resolveTaskRelatedMessageId\(item\)/);
  assert.ok(appSource.includes("from './chat/state/taskRelatedMessageResolve'"));
});

test('paused goal rows keep abandon beside open in the same action column', async () => {
  const [tasksPageSource, styles] = await Promise.all([
    readTasksPageSource(),
    readTaskOverviewStyles(),
  ]);

  assert.match(
    tasksPageSource,
    /className="task-row-actions"[\s\S]*?className="task-row-open"[\s\S]*?className="task-row-abandon"/,
  );
  assert.match(tasksPageSource, /item\.source === 'goal_plan' && item\.actionRight === 'paused'/);
  assert.match(tasksPageSource, /void clientApi\.goalPlansDelete\(\{ planId: item\.taskId \}\)/);
  assert.match(styles, /\.task-row-actions\s*\{/);
  assert.match(styles, /\.task-row-abandon\s*\{/);
  assert.match(styles, /color: var\(--state-danger, #c0392b\);/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.6fr\) minmax\(8rem, 0\.9fr\) minmax\(8rem, 0\.9fr\) 5rem 7\.5rem;/);
});
