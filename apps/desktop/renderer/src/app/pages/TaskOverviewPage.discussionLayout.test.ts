import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPageSource = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('home inbox no longer packs paused or result cards in WorkStream', async () => {
  const source = await readPageSource();
  assert.doesNotMatch(source, /<WorkStream items=\{paused\}>/);
  assert.doesNotMatch(source, /<WorkStream items=\{advancing\}>/);
  assert.match(source, /needsYouCards\.map\(\(card\) => \([\s\S]*?<HandoffRow/);
  assert.match(source, /pausedCards\.map\(\(card\) => \([\s\S]*?<WorkItem/);
  assert.match(source, /advancing\.map\(\(item\) => \([\s\S]*?<WorkItem/);
  assert.match(source, /groupInboxByConversation/);
});

test('unread conversations follow action sections without resurfacing read discussions', async () => {
  const source = await readPageSource();

  assert.match(source, /task-overview-discussion-grid/);
  assert.match(source, /const unread = items\.filter\(\(i\) => i\.source === 'conversation' && i\.isUnread === true\)/);
  assert.match(source, /const visibleUnread = unread\.slice\(0, DISCUSSION_PREVIEW_LIMIT\)/);
  assert.match(source, /<section className="task-overview-section task-overview-section--discuss">/);
  assert.match(source, /<h2>未读<\/h2>/);
  const needsYouAt = source.indexOf('<h2>需要你</h2>');
  const discussAt = source.indexOf('<h2>未读</h2>');
  assert.ok(needsYouAt >= 0 && discussAt > needsYouAt);
});

test('interrupted execution still excludes ordinary conversations', async () => {
  const source = await readPageSource();
  assert.match(
    source,
    /const paused = items\.filter\(\s*\(i\) => i\.source !== 'conversation' && i\.actionRight === 'paused',?\s*\);/,
  );
});

test('inbox cards reuse original card surfaces', async () => {
  const [source, styles] = await Promise.all([readPageSource(), readStyles()]);

  assert.match(source, /<DiscussionCard/);
  assert.match(source, /<WorkItem/);
  assert.match(source, /<HandoffRow/);
  assert.doesNotMatch(source, /task-overview-session-card/);
  assert.match(styles, /\.task-overview-inbox-cards\s*\{/);
});

test('background bar only mounts when something is advancing', async () => {
  const source = await readPageSource();

  assert.match(source, /backgroundBarHost && advancing\.length > 0/);
  assert.match(source, /<aside className="task-overview-background-bar"/);
  assert.doesNotMatch(source, /打开会话抽屉/);
  assert.doesNotMatch(source, /discussions\.length === 0 \? ' is-quiet'/);
});

test('home groups live handoffs by conversation without restoring the removed acceptance bucket', async () => {
  const source = await readPageSource();

  assert.match(source, /const needsYouCards = groupInboxByConversation\(needsYou\)/);
  assert.match(source, /const pausedCards = groupInboxByConversation\(paused\)/);
  assert.match(source, /const resultReady: TaskOverviewItem\[\] = \[\]/);
  assert.doesNotMatch(source, /<ResultCard/);
  assert.doesNotMatch(source, /const resultCards = groupInboxByConversation/);
  assert.doesNotMatch(source, /RESULT_PREVIEW_LIMIT/);
  assert.doesNotMatch(source, /previewedResults/);
});
