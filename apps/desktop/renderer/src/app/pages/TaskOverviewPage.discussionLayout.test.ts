import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readPageSource = () => readFile(new URL('./TaskOverviewPage.tsx', import.meta.url), 'utf8');
const readStyles = () => readFile(new URL('../../styles/task-overview.css', import.meta.url), 'utf8');

test('advancing and paused streams pack cards instead of stretching a flat grid', async () => {
  const source = await readPageSource();
  assert.match(source, /<WorkStream items=\{paused\}>/);
  assert.match(source, /<WorkStream items=\{advancing\}>/);
  assert.doesNotMatch(
    source,
    /<div className="task-overview-work-stream">\s*\{(paused|advancing)\.map/,
  );
});

test('discussion preview uses compact cards instead of execution WorkItem cards', async () => {
  const source = await readPageSource();
  const discussionSection = source.match(
    /<div className="task-overview-discussion-grid">([\s\S]*?)<\/div>/,
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
    /<h2 title="执行异常">执行异常<\/h2>[\s\S]*?<WorkStream items=\{paused\}>/,
  );

  assert.ok(interruptedSection, 'paused cards should reuse WorkStream');
  assert.match(
    styles,
    /\.task-overview-work-stream\s*\{[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 28rem\), 1fr\)\);/,
  );
  assert.match(
    styles,
    /\.task-overview-work-stream\s*\{[\s\S]*?align-items: start;/,
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

test('advancing cards keep route meta in the top bar and put runtime meta on the cancel row', async () => {
  const [source, styles] = await Promise.all([readPageSource(), readStyles()]);
  const workItem = source.slice(source.indexOf('/** 推进中工作卡'), source.indexOf('/** 结果待验收卡片'));

  assert.match(workItem, /<WorkItemMeta item=\{item\} group="route" \/>/);
  assert.match(workItem, /<div className="result-card-actions work-item-actions">/);
  assert.match(workItem, /<WorkItemMeta item=\{item\} group="runtime" \/>/);
  assert.match(workItem, /<div className="work-item-actions__buttons">/);
  assert.match(workItem, />\s*取消\s*</);
  assert.doesNotMatch(workItem, /<WorkItemMeta item=\{item\} \/>/);

  assert.match(styles, /\.work-item-actions \{[\s\S]*?justify-between/);
  assert.match(styles, /\.work-item-actions \{[\s\S]*?text-xs/);
  assert.match(styles, /\.work-item-actions__buttons \{/);
  assert.match(styles, /\.task-overview-work-meta--runtime \{[\s\S]*?justify-start/);
  assert.match(styles, /\.task-overview-work-meta--runtime \{[\s\S]*?text-xs/);
});

test('acceptance cards keep route meta in the top bar and put runtime meta on the result row', async () => {
  const source = await readPageSource();
  const resultCard = source.slice(source.indexOf('/** 结果待验收卡片'));

  assert.match(resultCard, /<WorkItemMeta item=\{item\} group="route" fallbackWhenEmpty="READY" \/>/);
  assert.match(resultCard, /<div className="result-card-actions work-item-actions">/);
  assert.match(resultCard, /<WorkItemMeta item=\{item\} group="runtime" fallbackWhenEmpty="READY" \/>/);
  assert.match(resultCard, /<div className="work-item-actions__buttons">/);
  assert.match(resultCard, />\s*查看结果\s*</);
  assert.doesNotMatch(resultCard, /<WorkItemMeta item=\{item\} fallbackWhenEmpty="READY" \/>/);
});

test('discussion section stays visible when there are no unread conversations', async () => {
  const source = await readPageSource();

  assert.doesNotMatch(source, /\{discussions\.length > 0 \? \(/);
  assert.match(source, /<section className="task-overview-section task-overview-section--discuss">/);
  assert.match(source, /\{visibleDiscussions\.length > 0 \? \(/);
  assert.match(source, /暂无未读讨论/);
});

test('home result-ready section renders the full queue and keeps the real total on the badge', async () => {
  const source = await readPageSource();

  assert.doesNotMatch(source, /RESULT_PREVIEW_LIMIT/);
  assert.doesNotMatch(source, /previewedResults/);
  assert.match(source, /groupResultCardsByGoalThread\(displayedResults, allItems \?\? items\)/);
  assert.match(source, /<small>\{resultReady\.length\}<\/small>/);
});

test('result-ready cards reuse WorkStream packing instead of a flat two-column grid', async () => {
  const [source, styles] = await Promise.all([readPageSource(), readStyles()]);

  assert.match(source, /<WorkStream[\s\S]*className="goal-thread-stream"/);
  assert.match(source, /weightOf=\{\(group\) => resultCardWeight\(group\.kind === 'thread' \? group\.nodes\.length : 0\)\}/);
  assert.doesNotMatch(
    source,
    /<div className="task-overview-work-stream goal-thread-stream">\s*\{groupResultCardsByGoalThread/,
  );
  assert.doesNotMatch(styles, /@media \(min-width: 768px\)[\s\S]*?\.result-card-stack/);
  assert.doesNotMatch(
    styles,
    /\.goal-thread-stream\s*\{[\s\S]*?grid-template-columns:\s*repeat\(auto-fit/,
  );
});
