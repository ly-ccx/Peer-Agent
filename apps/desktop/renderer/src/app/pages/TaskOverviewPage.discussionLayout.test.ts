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
  assert.match(source, /item\.statusLabel \|\| '有未读'/);
  assert.doesNotMatch(discussionSection, /advancingStateLabel/);
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
