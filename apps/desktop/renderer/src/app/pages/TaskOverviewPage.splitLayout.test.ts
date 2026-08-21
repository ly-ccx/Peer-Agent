import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPage = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () =>
  readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');
const readHome = () => readFile(new URL('./HomePage.tsx', import.meta.url), 'utf8');
const readApp = () => readFile(new URL('../../App.tsx', import.meta.url), 'utf8');

test('home is a single-column inbox, not a split workbench', async () => {
  const [source, styles] = await Promise.all([readPage(), readStyles()]);

  assert.doesNotMatch(source, /task-overview-split/);
  assert.doesNotMatch(source, /WorkListRow/);
  assert.doesNotMatch(source, /selectedTaskId/);
  assert.doesNotMatch(styles, /task-overview-split/);
  assert.match(source, /task-overview-page--home/);
  assert.match(styles, /\.task-overview-page--home\s*\{/);
});

test('inbox groups the same conversation into original cards', async () => {
  const source = await readPage();

  assert.match(source, /groupInboxByConversation/);
  assert.match(source, /<ResultCard/);
  assert.match(source, /<HandoffRow/);
  assert.match(source, /<WorkItem/);
  assert.match(source, /<h2>需要你处理<\/h2>/);
  assert.match(source, /<h2 title="执行异常">执行异常<\/h2>/);
  assert.match(source, /<h2>结果待验收<\/h2>/);
  assert.doesNotMatch(source, /<h2>现在轮到你<\/h2>/);
  assert.doesNotMatch(source, /task-overview-session-card/);
  assert.doesNotMatch(source, /<WorkStream items=\{paused\}>/);
});

test('advancing stays off the main column unless there is live work', async () => {
  const source = await readPage();

  assert.doesNotMatch(source, /<h2>Peer 正在推进<\/h2>/);
  assert.doesNotMatch(source, /<WorkStream items=\{advancing\}>/);
  assert.doesNotMatch(source, /<section className="task-overview-section task-overview-section--discuss">/);
  assert.match(source, /backgroundBarHost && advancing\.length > 0/);
  assert.match(source, /Peer 推进中/);
  assert.doesNotMatch(source, /打开会话抽屉/);
  assert.doesNotMatch(source, /Peer 待命/);
});

test('hero drops the marketing kicker and static stats', async () => {
  const source = await readPage();

  assert.doesNotMatch(source, /Delegation OS/);
  assert.doesNotMatch(source, /task-overview-hero-stats/);
  assert.match(source, /<h1>现在轮到你做什么<\/h1>/);
  assert.doesNotMatch(source, /onClick=\{[^}]*setHeroFilter/);
});

test('home subtitle describes one card per task', async () => {
  const home = await readHome();

  assert.match(home, /现在轮到我做什么/);
  assert.match(home, /一张卡是一件事/);
  assert.doesNotMatch(home, /同一会话收成一张卡/);
  assert.doesNotMatch(home, /工作和讨论在底栏/);
});

test('workbench cards open the conversation instead of the result drawer', async () => {
  const app = await readApp();

  assert.match(app, /handleContinueTask\(String\(conversationId\)\)/);
  assert.doesNotMatch(
    app,
    /if \(item\.actionRight === 'result_ready'\) \{\s*[\s\S]*?openResultDrawer\(item, options\);/,
  );
});
