import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPageSource = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('discussion preview uses compact cards instead of execution WorkItem cards', async () => {
  const source = await readPageSource();
  const discussionSection = source.match(
    /<div className="task-overview-discussion-grid">([\s\S]*?)<\/div>\s*<\/section>/,
  )?.[1];

  assert.ok(discussionSection, 'discussion grid should have a dedicated render branch');
  assert.match(discussionSection, /visibleDiscussions\.map/);
  assert.match(discussionSection, /<DiscussionCard/);
  assert.doesNotMatch(discussionSection, /<WorkItem/);
  assert.match(source, /const DISCUSSION_PREVIEW_LIMIT = 6;/);
  assert.match(source, /const visibleDiscussions = discussions\.slice\(0, DISCUSSION_PREVIEW_LIMIT\);/);
  assert.match(source, /item\.statusLabel \|\| '有未读'/);
  assert.doesNotMatch(discussionSection, /advancingStateLabel/);
});

test('discussion view-all link reports the total while the home preview stays capped', async () => {
  const source = await readPageSource();

  assert.match(source, /count=\{discussions\.length\}/);
  assert.match(source, /countHint=\{`共 \$\{discussions\.length\} 条`\}/);
  assert.doesNotMatch(source, /hiddenDiscussionCount/);
  assert.match(source, /const visibleDiscussions = discussions\.slice\(0, DISCUSSION_PREVIEW_LIMIT\);/);
});

test('interrupted execution excludes ordinary conversations and keeps recovery semantics', async () => {
  const source = await readPageSource();
  assert.match(
    source,
    /const paused = items\.filter\(\s*\(i\) => i\.source !== 'conversation' && i\.actionRight === 'paused',?\s*\);/,
  );
  assert.match(source, /title="执行异常"/);
  assert.match(source, /item\.issueDetail/);
  assert.match(source, /item\.nextAction === 'resume'/);
  assert.match(source, />\s*继续执行\s*</);
  assert.match(source, /item\.actionRight === 'paused' \? item\.statusLabel : advancingStateLabel\(item\)/);
});

test('interrupted execution reuses the container-responsive work stream', async () => {
  const [source, styles] = await Promise.all([readPageSource(), readStyles()]);
  const interruptedSection = source.match(
    /<h2 title="执行异常">执行异常<\/h2>[\s\S]*?<div className="(task-overview-work-[^"]+)">/,
  );

  assert.equal(interruptedSection?.[1], 'task-overview-work-stream');
  assert.match(
    styles,
    /\.task-overview-work-stream\s*\{[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 28rem\), 1fr\)\);/,
  );
  assert.doesNotMatch(
    styles,
    /@media \(min-width: 768px\)[\s\S]*?\.task-overview-work-stream/,
  );
});

test('discussion status visually distinguishes unread and read items', async () => {
  const [source, styles] = await Promise.all([readPageSource(), readStyles()]);

  assert.match(source, /statusLabel === '已读' \? 'is-read' : 'is-unread'/);
  assert.match(source, /task-overview-discussion-card__status \$\{statusTone\}/);
  assert.match(
    styles,
    /\.task-overview-discussion-card__status\.is-unread\s*\{[\s\S]*?color: var\(--za-accent\);[\s\S]*?background:/,
  );
  assert.match(
    styles,
    /\.task-overview-discussion-card__status\.is-read\s*\{[\s\S]*?color: var\(--za-text-muted\);[\s\S]*?background:/,
  );
  assert.match(
    styles,
    /\.task-overview-discussion-card__status\.is-read i\s*\{[\s\S]*?opacity: 0\.42;/,
  );
});

test('discussion grid has explicit spacing and responsive 3-2-1 columns', async () => {
  const styles = await readStyles();

  assert.match(
    styles,
    /\.task-overview-discussion-grid\s*\{[\s\S]*?@apply grid gap-4;[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    styles,
    /@media \(max-width: 1100px\)[\s\S]*?\.task-overview-discussion-grid\s*\{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.task-overview-discussion-grid\s*\{\s*grid-template-columns: 1fr;/,
  );
  assert.match(styles, /-webkit-line-clamp: 2;/);
});
