import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = () => readFile(new URL('./ChatHeader.tsx', import.meta.url), 'utf8');

test('ChatHeader only renders Workbench controls when a provider is available', async () => {
  const source = await readSource();

  assert.match(source, /const workbench = useWorkbenchOptional\(\);/);
  assert.match(source, /\{workbench \? <SidebarToggle isZh=\{isZh\} \/> : null\}/);
  assert.match(source, /\{workbench \? <WorkbenchToggle isZh=\{isZh\} \/> : null\}/);
  assert.match(source, /chat-header-branch/);
  assert.match(source, /chat-header-branch-text/);
  assert.doesNotMatch(source, /^\s*<SidebarToggle isZh=\{isZh\} \/>$/m);
  assert.doesNotMatch(source, /^\s*<WorkbenchToggle isZh=\{isZh\} \/>$/m);
});

test('bound branch chrome lives in chat-surface styles as truncated metadata', async () => {
  const css = await readFile(new URL('../../styles/chat-surface.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-header-branch\b/);
  assert.match(css, /\.chat-header-branch-text\b/);
  assert.match(css, /\.composer-bound-branch\b/);
  assert.match(css, /\.composer-bound-branch-text\b/);
  assert.match(css, /\.chat-header-branch \{[\s\S]*?flex:\s*0 1 auto;/);
  assert.match(css, /\.composer-bound-branch \{[\s\S]*?flex:\s*0 1 auto;/);
  assert.match(css, /\.composer-workspace-head\b/);
  assert.match(css, /\.composer-task-line\b/);
  assert.match(css, /\.composer-write-mismatch\b/);
  assert.doesNotMatch(css, /\.chat-header-branch \{[\s\S]*?flex:\s*0 1 11rem;/);
});
