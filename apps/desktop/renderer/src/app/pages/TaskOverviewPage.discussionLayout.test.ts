import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPageSource = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('home inbox no longer packs paused or result cards in WorkStream', async () => {
  const source = await readPageSource();
  assert.doesNotMatch(source, /<WorkStream items=\{paused\}>/);
  assert.doesNotMatch(source, /<WorkStream items=\{advancing\}>/);
  assert.match(source, /className="task-overview-work-stream goal-thread-stream"/);
  assert.match(source, /groupInboxByConversation/);
  assert.match(source, /groupResultCardsByGoalThread/);
});

test('discussions leave the main column', async () => {
  const source = await readPageSource();

  assert.doesNotMatch(source, /task-overview-discussion-grid/);
  assert.doesNotMatch(source, /visibleDiscussions/);
  assert.doesNotMatch(source, /DISCUSSION_PREVIEW_LIMIT/);
  assert.doesNotMatch(source, /<section className="task-overview-section task-overview-section--discuss">/);
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

  assert.match(source, /<ResultCard/);
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

test('home result-ready items fold into the conversation card', async () => {
  const source = await readPageSource();

  assert.match(source, /const needsYouCards = groupInboxByConversation\(needsYou\)/);
  assert.match(source, /const pausedCards = groupInboxByConversation\(paused\)/);
  assert.match(
    source,
    /const resultCards = groupInboxByConversation\(displayedResults\.map\(\(entry\) => entry\.item\)\)/,
  );
  assert.match(source, /groupResultCardsByGoalThread\(entries, allItems \?\? items\)/);
  assert.doesNotMatch(source, /RESULT_PREVIEW_LIMIT/);
  assert.doesNotMatch(source, /previewedResults/);
});
