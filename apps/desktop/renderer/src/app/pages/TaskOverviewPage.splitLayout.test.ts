import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');
const readHome = () => readFile(new URL('./HomePage.tsx', import.meta.url), 'utf8');

/**
 * 方案 A 双栏布局回归测试（源码结构断言，与 discussionLayout 同风格）。
 *
 * 2026-08-20：工作台从单列纵向长页改为双栏——
 * 左栏 task-overview-split-list 承载四组紧凑行（轮到你/执行异常/Peer 推进/讨论），
 * 右栏 task-overview-split-detail 渲染选中任务详情或默认待验收队列。
 * 点击左侧行（WorkListRow → setSelectedTaskId）切换右侧详情。
 */

test('split layout renders two columns: list on the left, detail on the right', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);

  assert.match(source, /<div className="task-overview-split">/);
  assert.match(source, /<div className="task-overview-split-list" role="list"/);
  assert.match(source, /<div className="task-overview-split-detail">/);

  assert.match(
    styles,
    /\.task-overview-split\s*\{[\s\S]*?grid-template-columns: minmax\(0, 40%\) minmax\(0, 1fr\);/,
  );
});

test('each split column scrolls independently instead of the whole page', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);

  assert.match(
    styles,
    /\.task-overview-split-list\s*\{[\s\S]*?overflow-y-auto/,
  );
  assert.match(
    styles,
    /\.task-overview-split-detail\s*\{[\s\S]*?overflow-y-auto/,
  );
  // 双栏容器自身不产生纵向滚动。
  assert.doesNotMatch(
    styles,
    /\.task-overview-split\s*\{[^}]*?overflow-y-auto/,
  );
  // 左栏四组分区全部收进 split-section（紧凑行），不再用整节 WorkStream 卡。
  const splitSections = source.match(/task-overview-split-section/g) ?? [];
  assert.ok(splitSections.length >= 4, `expected >= 4 split sections, got ${splitSections.length}`);
});

test('clicking a left row switches the right detail panel', async () => {
  const source = await readPage();

  // 状态与派生：选中 id + 从左栏条目中解析详情项。
  assert.match(source, /const \[selectedTaskId, setSelectedTaskId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const selectedDetailItem: TaskOverviewItem \| null = leftColumnItems\.find\(/);
  assert.match(source, /item\.taskId === selectedTaskId/);

  // 左栏行点击 → setSelectedTaskId；右栏渲染选中的 WorkItem。
  assert.match(source, /onSelect=\{setSelectedTaskId\}/);
  assert.match(source, /onClick=\{\(\) => onSelect\(item\.taskId\)\}/);
  assert.match(source, /<WorkItem\s*\n\s*item=\{selectedDetailItem\}/);

  // 未选中时的默认视图：待验收队列或占位说明。
  assert.match(source, /displayedResults\.length > 0 \? \(/);
  assert.match(source, /从左侧选择一个任务/);
});

test('left rows are compact single-line items with an active state', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);

  assert.match(source, /function WorkListRow\(/);
  assert.match(source, /task-overview-work-row\$\{active \? ' is-active' : ''\}/);
  assert.match(source, /aria-current=\{active \? 'true' : undefined\}/);

  assert.match(
    styles,
    /\.task-overview-work-row\s*\{[\s\S]*?truncate/,
  );
  assert.match(
    styles,
    /\.task-overview-work-row\.is-active\s*\{[\s\S]*?border-color: var\(--za-accent\);/,
  );
  // 按钮语义：可点、可聚焦、无 opacity 过渡（buttonCursor 约束同族）。
  assert.match(styles, /\.task-overview-work-row\s*\{[\s\S]*?cursor: pointer/);
  assert.doesNotMatch(
    styles,
    /\.task-overview-work-row\s*\{[^}]*?opacity\s*:/,
  );
});

test('hero stats are clickable chips that drive the right panel focus', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);

  assert.match(source, /className=\{`task-overview-stat\$\{selectedTaskId === null[^`]*\}`}/);
  assert.match(source, /role="button"/);
  assert.match(source, /onClick=\{\(\) => setSelectedTaskId\(null\)\}/);
  assert.match(
    source,
    /const first = needsYou\[0\] \?\? paused\[0\] \?\? advancing\[0\] \?\? null;/,
  );

  assert.match(styles, /\.task-overview-stat\s*\{[\s\S]*?cursor: pointer/);
  assert.match(styles, /\.task-overview-stat\.is-active\s*\{/);
});

test('HomePage subtitle no longer claims an empty workspace when tasks exist', async () => {
  const home = await readHome();

  // 空态话术只允许出现在 emptyLabel（仅在 hasAny 为 false 时渲染），不得再出现在副标题。
  assert.doesNotMatch(home, /subtitle=\{\s*isGlobal\s*\?\s*'[^']*还没有待办/);
  assert.doesNotMatch(home, /当前工作区还没有待办。先发出一条任务。/);
  // 空态文案仍在 emptyLabel 里保留，供真正的空态渲染。
  assert.match(home, /当前工作区还没有任务。发出第一条后会显示在这里。/);
});
