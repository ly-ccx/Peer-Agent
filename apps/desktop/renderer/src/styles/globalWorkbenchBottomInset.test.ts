import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const gwbCssUrl = new URL('./global-workbench.css', import.meta.url);
const pageUrl = new URL('../app/pages/GlobalWorkbenchPage.tsx', import.meta.url);

test('gwb scroll region keeps a radius-sized bottom inset so the last card clears the shell clip', async () => {
  const css = await readFile(gwbCssUrl, 'utf8');

  // GWB 是自持滚动器（不依赖外层 task-overview 滚动区），
  // 外层 603863f 的 padding-bottom 对 gwb 视口不生效，
  // 等价契约必须落在 .gwb-page 自己身上。
  assert.match(css, /\.gwb-page\s*\{[\s\S]*?overflow-y-auto[\s\S]*?padding-bottom:\s*var\(--radius-lg\);/);
});

test('gwb-page stays its own scroller (not absorbed into the region-level scroll region)', async () => {
  const source = await readFile(pageUrl, 'utf8');

  assert.match(source, /className=\{?"gwb-page"\}?/);
  // 防倒退：不允许把 gwb 滚动职责交还给外层滚动区来"复用"让位。
  assert.doesNotMatch(source, /task-overview-scroll-region/);
});
