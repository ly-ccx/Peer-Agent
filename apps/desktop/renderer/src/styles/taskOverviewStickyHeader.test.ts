import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageUrl = new URL('../app/pages/TaskOverviewPage.tsx', import.meta.url);
const cssUrl = new URL('./task-overview.css', import.meta.url);

test('workbench compact header is driven by a stable intersection sentinel', async () => {
  const source = await readFile(pageUrl, 'utf8');

  assert.match(source, /const headerSentinelRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(source, /new IntersectionObserver/);
  assert.match(source, /setIsHeaderCompact\(!entry\.isIntersecting\)/);
  assert.match(source, /closest<HTMLElement>\('\.task-overview-scroll-region'\)/);
  assert.match(source, /root: scrollContainer/);
  assert.match(source, /ref=\{headerSentinelRef\}/);
  assert.doesNotMatch(source, /scrollTop >|addEventListener\('scroll'/);
});

test('compact header is an overlay that cannot change document flow height', async () => {
  const css = await readFile(cssUrl, 'utf8');

  assert.match(css, /\.task-overview-compact-anchor\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?height:\s*0;/);
  assert.match(css, /\.task-overview-compact-header\s*\{[\s\S]*?position:\s*absolute;/);
  assert.match(css, /\.task-overview-compact-header\.is-visible\s*\{[\s\S]*?opacity:\s*1;/);
  assert.doesNotMatch(css, /task-overview-sticky-header|\.is-compact \.task-overview-hero/);
});

test('compact header shell mask and divider share one height source', async () => {
  const css = await readFile(cssUrl, 'utf8');

  assert.match(css, /\.task-overview-page-layer\s*\{[\s\S]*?--task-overview-compact-height:\s*3\.75rem;/);
  assert.match(css, /\.task-overview-page-layer\s*\{[\s\S]*?overflow-hidden/);
  assert.match(css, /\.task-overview-scroll-region\s*\{[\s\S]*?overflow-y-auto/);
  assert.match(css, /\.task-overview-page-layer:has\(\.task-overview-compact-header\.is-visible\)::before\s*\{[\s\S]*?height:\s*var\(--task-overview-compact-height\);[\s\S]*?background:\s*var\(--za-app-bg\);/);
  assert.match(css, /\.task-overview-page-layer:has\(\.task-overview-compact-header\.is-visible\)::after\s*\{[\s\S]*?top:\s*calc\(var\(--task-overview-compact-height\) - 1px\);[\s\S]*?background:\s*var\(--za-line\);/);
  assert.match(css, /\.task-overview-compact-header\s*\{[\s\S]*?height:\s*var\(--task-overview-compact-height\);/);
  assert.match(css, /@media \(max-width:\s*900px\)[\s\S]*?--task-overview-compact-height:\s*5\.5rem;/);
  assert.doesNotMatch(css, /top:\s*59px|min-height:\s*3\.75rem/);
});
