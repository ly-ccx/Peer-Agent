import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHook = () => readFile(new URL('./useTaskOverview.ts', import.meta.url), 'utf8');
const readChatSurface = () => readFile(new URL('../../chat/components/ChatSurface.tsx', import.meta.url), 'utf8');

test('TaskOverview hook sends the current conversation scope to main', async () => {
  const source = await readHook();

  assert.match(source, /conversationId\?: string \| null/);
  assert.match(source, /conversationId:\s*conversationId \?\? undefined/);
});

test('ChatSurface no longer mounts TaskOverview; workbench/sidebar own the projection', async () => {
  const source = await readChatSurface();
  const sidebar = await readFile(new URL('../../chat/components/SidebarWorkbenchCounts.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /useTaskOverview\(/);
  assert.match(sidebar, /useTaskOverview\(\{ workspacePath: null, includeTerminal: false \}\)/);
});

test('TaskOverview hook preserves the previous array when projection contents are unchanged', async () => {
  const source = await readHook();

  assert.match(source, /reuseUnchangedTaskOverviewItems/);
  assert.match(source, /setItems\(\(current\)\s*=>\s*reuseUnchangedTaskOverviewItems\(current, result\)\)/);
});

test('hidden document pauses both polling and broadcast-driven reloads', async () => {
  const source = await readHook();

  // 广播路径：document.hidden 时只置位 pending，不 reload。
  assert.match(
    source,
    /onTaskOverviewChanged\(\(payload: unknown\) => \{\s*\n\s*if \(document\.hidden\) \{\s*\n\s*pendingVisibleReloadRef\.current = true;\s*\n\s*return;/,
  );
  // 轮询路径：hidden 时根本不安装 interval。
  assert.match(source, /if \(document\.hidden\) return \(\) => \{\};/);
});

test('broadcast payload scope filters irrelevant reloads', async () => {
  const source = await readHook();

  assert.match(source, /isRelevantTaskOverviewChange/);
  // scoped 且带无关 conversationIds 时跳过 reload（旧 payload/无 scope 保守重拉）。
  assert.match(source, /if \(!isRelevantTaskOverviewChange\(payload, \{ conversationId \}\)\) return;/);
  assert.match(source, /scope\.scoped !== true\) return true/);
  assert.match(source, /ids\.some\(\(id\) => typeof id === 'string' && id === opts\.conversationId\)/);
});

test('visibilitychange resumes with one immediate sync', async () => {
  const source = await readHook();

  assert.match(source, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/);
  assert.match(
    source,
    /if \(!document\.hidden && pendingVisibleReloadRef\.current\) \{\s*\n\s*pendingVisibleReloadRef\.current = false;\s*\n\s*void reload\(\);/,
  );
});


test('TaskOverview fallback poll is slower than broadcast cadence', async () => {
  const source = await readHook();
  assert.match(source, /setInterval\([\s\S]*?15_000\)/);
  assert.doesNotMatch(source, /setInterval\([\s\S]*?,\s*4000\)/);
});
