import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');

test('district workbench opens the mounted-capability dropdown from the topline', async () => {
  const [app, home, overview, header] = await Promise.all([
    read('../App.tsx'),
    read('./pages/HomePage.tsx'),
    read('./pages/TaskOverviewPage.tsx'),
    read('../chat/components/thread/ChatHeaderCapabilities.tsx'),
  ]);

  assert.match(app, /<HomePage[\s\S]*?onOpenTools=\{\(\) => \{/);
  assert.match(home, /readonly onOpenTools\?: \(\) => void;/);
  assert.match(home, /onOpenTools=\{onOpenTools\}/);
  assert.match(overview, /ChatHeaderCapabilities/);
  assert.match(overview, /task-overview-topline-end/);
  assert.match(overview, /<TopLine[\s\S]*?onOpenTools=\{onOpenTools\}/);
  assert.doesNotMatch(overview, /本区已挂载/);
  assert.doesNotMatch(overview, /WorkspaceCapabilitySummary/);
  assert.match(header, /chat-header-cap-popover/);
  assert.match(header, /onOpenTools\?\.\(\)/);
});
